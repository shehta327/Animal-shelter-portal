// One Lambda function, two kinds of callers:
//   * API Gateway (HTTP API, payload v2)  -> the Express app via serverless-http
//   * EventBridge / EventBridge Scheduler -> consumers/handler.js
// Internal events never pass through API Gateway, so the public cannot trigger them.
const serverless = require('serverless-http');
const app = require('./app');
const { handleEvent } = require('./consumers/handler');

const http = serverless(app);

module.exports.handler = async (event, context) => {
  if (event && (event['detail-type'] || event.kind)) return handleEvent(event);
  return http(event, context);
};
