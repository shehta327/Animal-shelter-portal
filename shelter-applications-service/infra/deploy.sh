#!/usr/bin/env bash
# Adoption Applications service (owner: Mohamed Tibah)
# AWS services: Lambda + Secrets Manager + EventBridge + CloudWatch, behind the shared API Gateway.
# Data: Neon Postgres (external managed DB). Email: Resend (external API).
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
FN=shelter-applications-api
platform_or_exit

say "1. Secrets (values are never printed)"
if aws secretsmanager describe-secret --secret-id shelter/applications-db > /dev/null 2>&1; then ok "shelter/applications-db present"
else echo "   Missing shelter/applications-db: run infra/set-db-secret.sh first"; exit 1; fi
aws secretsmanager describe-secret --secret-id shelter/resend > /dev/null 2>&1 && ok "shelter/resend present" || ok "shelter/resend missing: emails will be skipped"

say "2. IAM role (least privilege)"
ensure_role shelter-applications-role infra/lambda-trust.json applications-least-privilege infra/policy.json

say "3. Lambda $FN"
build_zip
ensure_function $FN shelter-applications-role backend/lambda.zip lambda.handler \
  "Variables={NODE_ENV=production,SERVICE_NAME=applications,DB_SECRET_ID=shelter/applications-db,RESEND_SECRET_ID=shelter/resend,EVENT_BUS_NAME=shelter-bus,EVENT_SOURCE=shelter.applications,API_BASE_URL=$API_URL,API_CONNECT_URL=${API_CONNECT_URL:-$INTERNAL_FLOCI},CORS_ORIGINS=$PUBLIC_FLOCI,$COGNITO_ENV}" 20

say "4. Routes on the shared API Gateway"
wire_api $FN "GET /api/health/applications" "ANY /api/applications" "ANY /api/applications/{proxy+}"

say "5. Consume visit outcomes (unlocks approval)"
subscribe shelter-applications-visit-events $FN '{"source":["shelter.visits"],"detail-type":["VisitCompleted"]}'

say "6. CloudWatch monitoring"
monitoring $FN Shelter/Applications

say "Done: $API_URL/api/health/applications"
