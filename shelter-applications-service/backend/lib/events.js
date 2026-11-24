// Publishes domain events to the shared EventBridge bus "shelter-bus".
// Other services subscribe with rules; nobody calls this service's database.
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const log = require('./logger');

const client = new EventBridgeClient({});
const BUS = process.env.EVENT_BUS_NAME || 'shelter-bus';
const SOURCE = process.env.EVENT_SOURCE;

async function publish(detailType, detail) {
  const result = await client.send(new PutEventsCommand({
    Entries: [{ EventBusName: BUS, Source: SOURCE, DetailType: detailType, Detail: JSON.stringify(detail) }]
  }));
  if (result.FailedEntryCount) {
    log.error('event rejected', { detailType, code: result.Entries?.[0]?.ErrorCode });
    throw new Error('EventBridge rejected the event');
  }
  log.info('event published', { detailType, source: SOURCE });
}

module.exports = { publish };
