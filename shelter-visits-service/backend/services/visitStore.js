// Model: one DynamoDB table (VISITS_TABLE) holds three kinds of item:
//   SLOT#<id>                 a meet-and-greet slot      GSI1: ANIMAL#<animalId> / startsAt
//   BOOKING#<id>              an adopter's booking       GSI1: SLOT#<slotId> / startsAt
//                                                       GSI2: ADOPTER#<adopterId> / startsAt
//   ACTIVE#<adopter>#<animal> guard: one active booking per adopter per animal
// Capacity and double-booking rules are enforced by DynamoDB transactions with
// conditions, so two adopters clicking at the same moment cannot overbook.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand, TransactWriteCommand
} = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.VISITS_TABLE || 'ShelterVisits';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const slotKey = (id) => ({ pk: `SLOT#${id}`, sk: 'META' });
const bookingKey = (id) => ({ pk: `BOOKING#${id}`, sk: 'META' });
const guardKey = (adopterId, animalId) => ({ pk: `ACTIVE#${adopterId}#${animalId}`, sk: 'META' });

// Which condition in a transaction failed (DynamoDB returns one reason per item)
function failedItems(error) {
  if (error.name !== 'TransactionCanceledException') return null;
  const reasons = error.CancellationReasons || [];
  if (reasons.length) return reasons.map((r) => r && r.Code === 'ConditionalCheckFailed');
  // Some emulators only put the reasons in the message: "[ConditionalCheckFailed, None, ...]"
  const m = /\[([^\]]*)\]/.exec(error.message || '');
  return m ? m[1].split(',').map((s) => s.trim() === 'ConditionalCheckFailed') : [];
}

async function createSlot(slot) {
  const item = { ...slotKey(slot.slotId), type: 'slot', ...slot, gsi1pk: `ANIMAL#${slot.animalId}`, gsi1sk: slot.startsAt };
  await db.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
  return item;
}

async function getSlot(id) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: slotKey(id) }));
  return Item || null;
}

async function getBooking(id) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: bookingKey(id) }));
  return Item || null;
}

async function queryIndex(index, pkName, pkValue, skName, from, to) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({
      TableName: TABLE,
      IndexName: index,
      KeyConditionExpression: `#pk = :pk${from ? ' AND #sk BETWEEN :from AND :to' : ''}`,
      ExpressionAttributeNames: from ? { '#pk': pkName, '#sk': skName } : { '#pk': pkName },
      ExpressionAttributeValues: from ? { ':pk': pkValue, ':from': from, ':to': to } : { ':pk': pkValue },
      ExclusiveStartKey
    }));
    out.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const slotsForAnimal = (animalId, from, to) =>
  queryIndex('gsi1', 'gsi1pk', `ANIMAL#${animalId}`, 'gsi1sk', from, to);
const bookingsForSlot = (slotId) => queryIndex('gsi1', 'gsi1pk', `SLOT#${slotId}`);
const bookingsForAdopter = (adopterId) => queryIndex('gsi2', 'gsi2pk', `ADOPTER#${adopterId}`);

async function allBookings() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: '#t = :b',
      ExpressionAttributeNames: { '#t': 'type' },
      ExpressionAttributeValues: { ':b': 'booking' },
      ExclusiveStartKey
    }));
    out.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

// Book one place: slot must be open, in the future and not full; the adopter
// must not already hold an active booking for this animal.
async function book(slot, booking) {
  const now = new Date().toISOString();
  const item = {
    ...bookingKey(booking.bookingId), type: 'booking', ...booking,
    gsi1pk: `SLOT#${slot.slotId}`, gsi1sk: slot.startsAt,
    gsi2pk: `ADOPTER#${booking.adopterId}`, gsi2sk: slot.startsAt
  };
  try {
    await db.send(new TransactWriteCommand({
      TransactItems: [
        { Update: {
          TableName: TABLE, Key: slotKey(slot.slotId),
          UpdateExpression: 'SET bookedCount = bookedCount + :one',
          ConditionExpression: '#s = :open AND bookedCount < #cap AND startsAt > :now',
          ExpressionAttributeNames: { '#s': 'status', '#cap': 'capacity' }, // capacity is a DynamoDB reserved word
          ExpressionAttributeValues: { ':one': 1, ':open': 'open', ':now': now }
        } },
        { Put: { TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: {
          TableName: TABLE,
          Item: { ...guardKey(booking.adopterId, booking.animalId), type: 'guard', bookingId: booking.bookingId },
          ConditionExpression: 'attribute_not_exists(pk)'
        } }
      ]
    }));
    return { ok: true, booking: item };
  } catch (error) {
    const failed = failedItems(error);
    if (!failed) throw error;
    if (failed[2]) return { ok: false, reason: 'ALREADY_BOOKED' };
    return { ok: false, reason: 'SLOT_UNAVAILABLE' };
  }
}

// booked -> cancelled | completed | no_show, releasing the guard (and the seat on cancel)
async function closeBooking(booking, toStatus, fields = {}) {
  const now = new Date().toISOString();
  const sets = ['#s = :to', 'updatedAt = :now'];
  const values = { ':to': toStatus, ':booked': 'booked', ':now': now };
  Object.entries(fields).forEach(([k, val], i) => { sets.push(`#f${i} = :f${i}`); values[`:f${i}`] = val; });
  const names = { '#s': 'status', ...Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k])) };
  const items = [
    { Update: {
      TableName: TABLE, Key: bookingKey(booking.bookingId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#s = :booked',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    } },
    { Delete: { TableName: TABLE, Key: guardKey(booking.adopterId, booking.animalId) } }
  ];
  if (toStatus === 'cancelled') {
    items.push({ Update: {
      TableName: TABLE, Key: slotKey(booking.slotId),
      UpdateExpression: 'SET bookedCount = bookedCount - :one',
      ConditionExpression: 'bookedCount > :zero',
      ExpressionAttributeValues: { ':one': 1, ':zero': 0 }
    } });
  }
  try {
    await db.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (failedItems(error)) return false;
    throw error;
  }
}

async function cancelSlot(slotId, by) {
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE, Key: slotKey(slotId),
      UpdateExpression: 'SET #s = :c, cancelledBy = :by, updatedAt = :now',
      ConditionExpression: '#s = :open',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':c': 'cancelled', ':open': 'open', ':by': by, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

module.exports = {
  createSlot, getSlot, getBooking, slotsForAnimal, bookingsForSlot, bookingsForAdopter, allBookings,
  book, closeBooking, cancelSlot
};
