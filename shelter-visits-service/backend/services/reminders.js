// EventBridge Scheduler: one-time schedule per booking that invokes this
// Lambda REMINDER_MINUTES_BEFORE the visit (default 24 h) to email a reminder.
// The schedule deletes itself after running; a cancelled booking deletes it early.
const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');
const log = require('../lib/logger');

const scheduler = new SchedulerClient({});
const MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 1440);
const name = (bookingId) => `visit-reminder-${bookingId}`;

async function scheduleReminder(booking) {
  const at = new Date(Date.parse(booking.startsAt) - MINUTES_BEFORE * 60 * 1000);
  if (at.getTime() < Date.now() + 60 * 1000 || !process.env.VISITS_FUNCTION_ARN) return false;  // too late, or running on a PC
  try {
    await scheduler.send(new CreateScheduleCommand({
      Name: name(booking.bookingId),
      GroupName: process.env.SCHEDULE_GROUP || 'default',
      ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: process.env.VISITS_FUNCTION_ARN,
        RoleArn: process.env.SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ kind: 'VisitReminder', bookingId: booking.bookingId })
      }
    }));
    log.info('reminder scheduled', { bookingId: booking.bookingId, at: at.toISOString() });
    return true;
  } catch (error) {
    log.warn('reminder not scheduled', { bookingId: booking.bookingId, error: error.name });
    return false;
  }
}

async function cancelReminder(bookingId) {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: name(bookingId), GroupName: process.env.SCHEDULE_GROUP || 'default' }));
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') log.warn('reminder not deleted', { bookingId, error: error.name });
  }
}

module.exports = { scheduleReminder, cancelReminder };
