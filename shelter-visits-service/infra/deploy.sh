#!/usr/bin/env bash
# Visit Scheduling service (owner: Abdelrahman Shehta)
# AWS services: Lambda + DynamoDB + EventBridge Scheduler (reminders) + EventBridge + Secrets Manager + CloudWatch.
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
FN=shelter-visits-api
platform_or_exit

say "1. DynamoDB table ShelterVisits (slots, bookings, one-booking guards)"
if aws dynamodb describe-table --table-name ShelterVisits > /dev/null 2>&1; then ok "table exists"
else
  aws dynamodb create-table --table-name ShelterVisits --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
      AttributeName=gsi1pk,AttributeType=S AttributeName=gsi1sk,AttributeType=S AttributeName=gsi2pk,AttributeType=S AttributeName=gsi2sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes \
      'IndexName=gsi1,KeySchema=[{AttributeName=gsi1pk,KeyType=HASH},{AttributeName=gsi1sk,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
      'IndexName=gsi2,KeySchema=[{AttributeName=gsi2pk,KeyType=HASH},{AttributeName=gsi2sk,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
    > /dev/null && aws dynamodb wait table-exists --table-name ShelterVisits && ok "table created"
fi
aws dynamodb update-continuous-backups --table-name ShelterVisits \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true > /dev/null 2>&1 && ok "point-in-time recovery on"

say "2. IAM roles (least privilege): the function, and the scheduler that may only invoke it"
ensure_role shelter-visits-role infra/lambda-trust.json visits-least-privilege infra/policy.json
ensure_role shelter-visits-scheduler-role infra/scheduler-trust.json invoke-visits-only infra/scheduler-policy.json

say "3. EventBridge Scheduler group for reminders"
aws scheduler create-schedule-group --name shelter-visit-reminders > /dev/null 2>&1 && ok "group created" || ok "group exists"

say "4. Lambda $FN"
build_zip
ensure_function $FN shelter-visits-role backend/lambda.zip lambda.handler \
  "Variables={NODE_ENV=production,SERVICE_NAME=visits,VISITS_TABLE=ShelterVisits,EVENT_BUS_NAME=shelter-bus,EVENT_SOURCE=shelter.visits,RESEND_SECRET_ID=shelter/resend,SCHEDULE_GROUP=shelter-visit-reminders,REMINDER_MINUTES_BEFORE=${REMINDER_MINUTES_BEFORE:-1440},VISIT_LEAD_MINUTES=${VISIT_LEAD_MINUTES:-60},SLOT_STEP_MINUTES=${SLOT_STEP_MINUTES:-30},VISITS_FUNCTION_ARN=arn:aws:lambda:$REGION:$ACCOUNT:function:$FN,SCHEDULER_ROLE_ARN=arn:aws:iam::$ACCOUNT:role/shelter-visits-scheduler-role,API_BASE_URL=$API_URL,API_CONNECT_URL=${API_CONNECT_URL:-$INTERNAL_FLOCI},CORS_ORIGINS=$PUBLIC_FLOCI,$COGNITO_ENV}" 20

say "5. Routes on the shared API Gateway"
wire_api $FN "GET /api/health/visits" "ANY /api/visits" "ANY /api/visits/{proxy+}"

say "6. Consume animal status changes (cancel visits of adopted / withdrawn animals)"
subscribe shelter-visits-animal-events $FN \
  '{"source":["shelter.animals"],"detail-type":["AnimalStatusChanged"],"detail":{"to":["adopted","archived","on_hold"]}}'

say "7. CloudWatch monitoring"
monitoring $FN Shelter/Visits

say "Done: $API_URL/api/health/visits"
