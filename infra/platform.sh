#!/usr/bin/env bash
# Shared platform (owned by the whole team): Cognito sign-in for all three
# services, the EventBridge bus they talk over, the one API Gateway in front of
# them, the S3 website bucket and the Resend secret placeholder.
# Safe to run again: it reuses what already exists.
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
mkdir -p infra/out

say "1. Cognito user pool shelter-users (sign-up / sign-in for every role)"
POOL=$(pool_id)
if none "$POOL"; then
  POOL=$(aws cognito-idp create-user-pool --pool-name shelter-users \
    --username-attributes email --auto-verified-attributes email \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
    --schema Name=name,AttributeDataType=String,Mutable=true,Required=false \
    --admin-create-user-config AllowAdminCreateUserOnly=false \
    --query UserPool.Id --output text)
  ok "pool created: $POOL"
else ok "pool exists: $POOL"; fi

say "2. PreSignUp Lambda (auto-confirm; never grants a role)"
ensure_role shelter-presignup-role infra/lambda-trust.json presignup-logs infra/presignup-policy.json
node infra/zip.js infra/presignup infra/out/presignup.zip > /dev/null || { echo "Node.js is needed for the zip step"; exit 1; }
ensure_function shelter-presignup shelter-presignup-role infra/out/presignup.zip index.handler 'Variables={NODE_ENV=production}' 15 128
aws lambda add-permission --function-name shelter-presignup --statement-id cognito-presignup --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com --source-arn "arn:aws:cognito-idp:$REGION:$ACCOUNT:userpool/$POOL" > /dev/null 2>&1
# update-user-pool resets every setting it is not given, so the password policy is repeated here
aws cognito-idp update-user-pool --user-pool-id "$POOL" --auto-verified-attributes email \
  --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
  --admin-create-user-config AllowAdminCreateUserOnly=false \
  --lambda-config "PreSignUp=arn:aws:lambda:$REGION:$ACCOUNT:function:shelter-presignup" > /dev/null && ok "trigger attached"

say "3. App client shelter-web (public client: no secret in the browser)"
CLIENT=$(client_id "$POOL")
if none "$CLIENT"; then
  CLIENT=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL" --client-name shelter-web --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --id-token-validity 60 --access-token-validity 60 --refresh-token-validity 1 \
    --token-validity-units IdToken=minutes,AccessToken=minutes,RefreshToken=days \
    --query UserPoolClient.ClientId --output text)
  ok "client created: $CLIENT"
else ok "client exists: $CLIENT"; fi

say "4. Groups = roles (no group = adopter)"
for G in Admin Staff; do
  aws cognito-idp create-group --user-pool-id "$POOL" --group-name "$G" --description "$G role" > /dev/null 2>&1 && ok "group $G created" || ok "group $G exists"
done

say "5. Seed accounts (passwords are NOT stored in the repo)"
SEED_FILE=infra/out/seed-users.txt
if [ ! -f "$SEED_FILE" ]; then
  gen() { echo "Shelter$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')a"; }
  {
    echo "# Demo accounts on the local Floci pool - this file is git-ignored. Do not commit it."
    for U in admin:Admin staff:Staff adopter1: adopter2:; do
      echo "${U%%:*}@shelter.test ${SEED_PASSWORD:-$(gen)} ${U#*:}"
    done
  } > "$SEED_FILE"
fi
grep -v '^#' "$SEED_FILE" | while read -r EMAIL PASS GROUP; do
  NAME=$(echo "${EMAIL%%@*}" | sed 's/^./\U&/; s/\([0-9]\)$/ \1/')
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" --message-action SUPPRESS \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true Name=name,Value="$NAME" > /dev/null 2>&1
  # the first sign-up trigger run is a cold start on Floci: wait until the user really exists
  for i in 1 2 3 4 5 6 7 8 9 10; do aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" > /dev/null 2>&1 && break; sleep 2; done
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$EMAIL" --password "$PASS" --permanent > /dev/null
  [ -n "$GROUP" ] && aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$EMAIL" --group-name "$GROUP" > /dev/null
  ok "$EMAIL ${GROUP:-adopter}"
done
ok "passwords: infra/out/seed-users.txt (local only)"

say "6. EventBridge bus shelter-bus (service-to-service events)"
aws events create-event-bus --name shelter-bus > /dev/null 2>&1 && ok "bus created" || ok "bus exists"

say "7. API Gateway shelter-http-api (one front door; each service adds its own routes)"
API=$(api_id)
if none "$API"; then
  API=$(aws apigatewayv2 create-api --name shelter-http-api --protocol-type HTTP --query ApiId --output text)
  aws apigatewayv2 create-stage --api-id "$API" --stage-name '$default' --auto-deploy \
    --default-route-settings ThrottlingBurstLimit=50,ThrottlingRateLimit=20 > /dev/null
  ok "api created: $API (stage \$default, throttling 20 req/s, burst 50)"
else ok "api exists: $API"; fi
API_URL="http://$API.execute-api.localhost.floci.io:4566"

say "8. Website bucket shelter-web"
aws s3 mb s3://shelter-web > /dev/null 2>&1 && ok "bucket created" || ok "bucket exists"

say "9. Secret shelter/resend (placeholder only - put the real key with infra/set-resend-key.sh)"
if aws secretsmanager describe-secret --secret-id shelter/resend > /dev/null 2>&1; then ok "secret exists (value not shown)"
else
  aws secretsmanager create-secret --name shelter/resend --description "Resend API key for shelter emails" \
    --secret-string '{"apiKey":"re_REPLACE_ME","from":"Shelter Portal <onboarding@resend.dev>","testRecipient":""}' > /dev/null && ok "placeholder created"
fi

cat > infra/out/platform.env <<ENV
# IDs only (no secrets). Generated by infra/platform.sh
USER_POOL_ID=$POOL
COGNITO_CLIENT_ID=$CLIENT
COGNITO_ISSUER=$(issuer_of "$POOL")
API_ID=$API
API_URL=$API_URL
WEBSITE=$PUBLIC_FLOCI/shelter-web/index.html
ENV
say "Done"; cat infra/out/platform.env
