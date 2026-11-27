// Structured JSON logs: one line per event, readable in CloudWatch Logs and
// filterable with metric filters (e.g. "AUTH_DENIED"). Never pass tokens,
// passwords, request bodies or email addresses in `fields`.
const SERVICE = process.env.SERVICE_NAME || 'service';

function write(level, msg, fields = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};
