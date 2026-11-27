// Model: animals in the DynamoDB table named by ANIMALS_TABLE.
//   key: id (String)   GSI "status-createdAt-index": status + createdAt (newest first)
// Status rules live in conditional writes, so two requests can never both win.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand
} = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.ANIMALS_TABLE || 'ShelterAnimals';
const STATUS_INDEX = 'status-createdAt-index';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const isConditionFailure = (e) => e.name === 'ConditionalCheckFailedException';

async function create(animal) {
  await db.send(new PutCommand({ TableName: TABLE, Item: animal, ConditionExpression: 'attribute_not_exists(id)' }));
  return animal;
}

async function get(id) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return Item || null;
}

async function listByStatus(status) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({
      TableName: TABLE,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ScanIndexForward: false,
      ExclusiveStartKey
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < 500);
  return items;
}

// Update profile fields. Adopted and archived animals are read-only.
async function updateDetails(id, fields) {
  const names = { '#status': 'status', '#u': 'updatedAt' };
  const values = { ':adopted': 'adopted', ':archived': 'archived', ':now': new Date().toISOString() };
  const sets = ['#u = :now'];
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`#f${i} = :v${i}`);
  });
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(id) AND #status <> :adopted AND #status <> :archived',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

// Move an animal from one of `fromStatuses` to `toStatus`, atomically.
// `extraSet` / `remove` update related fields; `requireReservation` pins the
// change to the application that reserved the animal.
async function changeStatus(id, fromStatuses, toStatus, { extraSet = {}, remove = [], requireReservation } = {}) {
  const now = new Date().toISOString();
  const names = { '#status': 'status', '#u': 'updatedAt', '#sc': 'statusChangedAt' };
  const values = { ':to': toStatus, ':now': now };
  const sets = ['#status = :to', '#u = :now', '#sc = :now'];
  Object.entries(extraSet).forEach(([k, v], i) => {
    names[`#x${i}`] = k;
    values[`:x${i}`] = v;
    sets.push(`#x${i} = :x${i}`);
  });
  const fromKeys = fromStatuses.map((s, i) => { values[`:from${i}`] = s; return `:from${i}`; });
  let condition = `attribute_exists(id) AND #status IN (${fromKeys.join(', ')})`;
  if (requireReservation) {
    names['#r'] = 'reservedForApplicationId';
    values[':r'] = requireReservation;
    condition += ' AND #r = :r';
  }
  const removeNames = remove.map((k, i) => { names[`#rm${i}`] = k; return `#rm${i}`; });
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: `SET ${sets.join(', ')}${removeNames.length ? ` REMOVE ${removeNames.join(', ')}` : ''}`,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

// Photos are a map photoId -> photo. photoCount enforces the limit atomically.
async function addPhoto(id, photo, maxPhotos) {
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: 'SET photos.#p = :photo, photoCount = if_not_exists(photoCount, :zero) + :one, updatedAt = :now',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(photoCount) OR photoCount < :max) AND #status IN (:a, :h, :r)',
      ExpressionAttributeNames: { '#p': photo.id, '#status': 'status' },
      ExpressionAttributeValues: {
        ':photo': photo, ':zero': 0, ':one': 1, ':max': maxPhotos, ':now': new Date().toISOString(),
        ':a': 'available', ':h': 'on_hold', ':r': 'reserved'
      },
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

async function markPhotoReady(id, photoId, size) {
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: 'SET photos.#p.#st = :ready, photos.#p.#sz = :size, updatedAt = :now',
      ConditionExpression: 'attribute_exists(photos.#p)',
      ExpressionAttributeNames: { '#p': photoId, '#st': 'status', '#sz': 'size' },
      ExpressionAttributeValues: { ':ready': 'ready', ':size': size, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

async function removePhoto(id, photoId) {
  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: 'REMOVE photos.#p SET photoCount = photoCount - :one, updatedAt = :now',
      ConditionExpression: 'attribute_exists(photos.#p)',
      ExpressionAttributeNames: { '#p': photoId },
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_OLD'
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

module.exports = { create, get, listByStatus, updateDetails, changeStatus, addPhoto, markPhotoReady, removePhoto };
