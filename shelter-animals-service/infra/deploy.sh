#!/usr/bin/env bash
# Animal Listings service (owner: Abdelrahman Magdy)
# AWS services: Lambda + DynamoDB + S3 (private photos) + EventBridge + CloudWatch, behind the shared API Gateway.
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
FN=shelter-animals-api
platform_or_exit

say "1. DynamoDB table ShelterAnimals (+ status index for listing)"
if aws dynamodb describe-table --table-name ShelterAnimals > /dev/null 2>&1; then ok "table exists"
else
  aws dynamodb create-table --table-name ShelterAnimals --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=id,AttributeType=S AttributeName=status,AttributeType=S AttributeName=createdAt,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --global-secondary-indexes 'IndexName=status-createdAt-index,KeySchema=[{AttributeName=status,KeyType=HASH},{AttributeName=createdAt,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
    > /dev/null && aws dynamodb wait table-exists --table-name ShelterAnimals && ok "table created"
fi
aws dynamodb update-continuous-backups --table-name ShelterAnimals \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true > /dev/null 2>&1 && ok "point-in-time recovery on"

say "2. Private S3 bucket shelter-animal-photos (presigned URLs only)"
aws s3 mb s3://shelter-animal-photos > /dev/null 2>&1 && ok "bucket created" || ok "bucket exists"
aws s3api put-public-access-block --bucket shelter-animal-photos \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true > /dev/null 2>&1 && ok "public access blocked"
aws s3api put-bucket-cors --bucket shelter-animal-photos --cors-configuration file://infra/photos-cors.json && ok "CORS: website origin only"
aws s3api put-bucket-encryption --bucket shelter-animal-photos \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' > /dev/null 2>&1 && ok "encryption at rest (SSE-S3)"

say "3. IAM role (least privilege)"
ensure_role shelter-animals-role infra/lambda-trust.json animals-least-privilege infra/policy.json

say "4. Lambda $FN"
build_zip
ensure_function $FN shelter-animals-role backend/lambda.zip lambda.handler \
  "Variables={NODE_ENV=production,SERVICE_NAME=animals,ANIMALS_TABLE=ShelterAnimals,PHOTOS_BUCKET=shelter-animal-photos,EVENT_BUS_NAME=shelter-bus,EVENT_SOURCE=shelter.animals,CORS_ORIGINS=$PUBLIC_FLOCI,$COGNITO_ENV}"

say "5. Routes on the shared API Gateway"
wire_api $FN "GET /api/health/animals" "ANY /api/animals" "ANY /api/animals/{proxy+}"

say "6. Consume adoption events (reserve / adopt / release)"
subscribe shelter-animals-adoption-events $FN \
  '{"source":["shelter.applications"],"detail-type":["ApplicationApproved","ApplicationCompleted","ApplicationReleased"]}'

say "7. CloudWatch monitoring"
monitoring $FN Shelter/Animals

say "Done: $API_URL/api/health/animals"
