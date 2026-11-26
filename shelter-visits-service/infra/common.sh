# Shared settings for the infra scripts. Works two ways:
#  * Git Bash with the AWS CLI and the Lab 7 "floci" profile:  bash infra/<script>.sh
#  * no AWS CLI installed: run through Docker with infra/run.ps1 <script>.sh
export AWS_PAGER="" MSYS_NO_PATHCONV=1
if [ -z "$AWS_ENDPOINT_URL" ] && [ -z "$AWS_PROFILE" ]; then export AWS_PROFILE=floci; fi
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}
REGION=$AWS_DEFAULT_REGION
ACCOUNT=000000000000
RUNTIME=${LAMBDA_RUNTIME:-nodejs24.x}
# Addresses the BROWSER uses (the website, Cognito and the API all on port 4566)
PUBLIC_FLOCI=http://localhost:4566
# Address Lambda containers use to reach Floci (Floci injects this name)
INTERNAL_FLOCI=http://localhost.floci.io:4566

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   %s\n' "$*"; }
none() { [ -z "$1" ] || [ "$1" = "None" ] || [ "$1" = "null" ]; }

pool_id() { aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='shelter-users'].Id | [0]" --output text; }
client_id() { aws cognito-idp list-user-pool-clients --user-pool-id "$1" --query "UserPoolClients[?ClientName=='shelter-web'].ClientId | [0]" --output text; }
api_id() { aws apigatewayv2 get-apis --query "Items[?Name=='shelter-http-api'].ApiId | [0]" --output text; }

ensure_role() { # name trust-file policy-name policy-file
  if ! aws iam get-role --role-name "$1" > /dev/null 2>&1; then
    aws iam create-role --role-name "$1" --assume-role-policy-document "file://$2" > /dev/null && ok "role $1 created"
  fi
  aws iam put-role-policy --role-name "$1" --policy-name "$3" --policy-document "file://$4" && ok "least-privilege policy $3 attached"
}

ensure_function() { # name role zip handler env-json [timeout] [memory]
  local arn="arn:aws:iam::$ACCOUNT:role/$2"
  if aws lambda get-function --function-name "$1" > /dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file "fileb://$3" > /dev/null
    aws lambda wait function-updated-v2 --function-name "$1" 2> /dev/null
    aws lambda update-function-configuration --function-name "$1" --handler "$4" --runtime "$RUNTIME" \
      --timeout "${6:-15}" --memory-size "${7:-256}" --environment "$5" > /dev/null
    ok "function $1 updated"
  else
    aws lambda create-function --function-name "$1" --runtime "$RUNTIME" --role "$arn" --handler "$4" \
      --zip-file "fileb://$3" --timeout "${6:-15}" --memory-size "${7:-256}" --environment "$5" > /dev/null
    ok "function $1 created"
  fi
  aws lambda wait function-active-v2 --function-name "$1" 2> /dev/null
  aws lambda wait function-updated-v2 --function-name "$1" 2> /dev/null
  aws logs create-log-group --log-group-name "/aws/lambda/$1" > /dev/null 2>&1
  aws logs put-retention-policy --log-group-name "/aws/lambda/$1" --retention-in-days 14 > /dev/null 2>&1
  return 0
}

# ---- helpers used by each service's infra/deploy.sh
platform_or_exit() {
  POOL=$(pool_id); API=$(api_id)
  if none "$POOL" || none "$API"; then echo "The shared platform is missing: run infra/platform.sh in the shelter-web repo first."; exit 1; fi
  CLIENT=$(client_id "$POOL")
  API_URL="http://$API.execute-api.localhost.floci.io:4566"
  COGNITO_ENV="COGNITO_ISSUER=$PUBLIC_FLOCI/$POOL,COGNITO_CLIENT_ID=$CLIENT,COGNITO_JWKS_URL=$INTERNAL_FLOCI/$POOL/.well-known/jwks.json"
}

build_zip() { # run npm install + zip in backend/
  (cd backend && npm install --omit=dev --no-audit --no-fund --loglevel=error && npm run zip --silent) || { echo "build failed"; exit 1; }
}

wire_api() { # function-name route-key...  (adds this service's routes to the shared API)
  local fn=$1; shift
  local uri="arn:aws:lambda:$REGION:$ACCOUNT:function:$fn"
  local integ
  integ=$(aws apigatewayv2 get-integrations --api-id "$API" --query "Items[?IntegrationUri=='$uri'].IntegrationId | [0]" --output text)
  if none "$integ"; then
    integ=$(aws apigatewayv2 create-integration --api-id "$API" --integration-type AWS_PROXY --payload-format-version 2.0 \
      --integration-uri "$uri" --timeout-in-millis 15000 --query IntegrationId --output text)
  fi
  for r in "$@"; do
    if none "$(aws apigatewayv2 get-routes --api-id "$API" --query "Items[?RouteKey=='$r'].RouteId | [0]" --output text)"; then
      aws apigatewayv2 create-route --api-id "$API" --route-key "$r" --target "integrations/$integ" > /dev/null && ok "route $r"
    else ok "route $r exists"; fi
  done
  aws lambda add-permission --function-name "$fn" --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API/*" > /dev/null 2>&1
  return 0
}

subscribe() { # rule-name function-name event-pattern-json  (this service consumes events from the bus)
  aws events put-rule --name "$1" --event-bus-name shelter-bus --event-pattern "$3" > /dev/null
  aws events put-targets --rule "$1" --event-bus-name shelter-bus \
    --targets "Id=1,Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$2" > /dev/null
  aws lambda add-permission --function-name "$2" --statement-id "events-$1" --action lambda:InvokeFunction \
    --principal events.amazonaws.com --source-arn "arn:aws:events:$REGION:$ACCOUNT:rule/shelter-bus/$1" > /dev/null 2>&1
  ok "rule $1 -> $2"
}

monitoring() { # function-name namespace  (metric filters + alarms on the function's log group)
  local lg="/aws/lambda/$1"
  aws logs put-metric-filter --log-group-name "$lg" --filter-name "$1-auth-denied" \
    --filter-pattern '{ $.msg = "AUTH_DENIED" }' \
    --metric-transformations "metricName=AuthDenied,metricNamespace=$2,metricValue=1,defaultValue=0" && ok "metric filter AuthDenied"
  aws logs put-metric-filter --log-group-name "$lg" --filter-name "$1-errors" \
    --filter-pattern '{ $.level = "error" }' \
    --metric-transformations "metricName=ServerErrors,metricNamespace=$2,metricValue=1,defaultValue=0" && ok "metric filter ServerErrors"
  aws cloudwatch put-metric-alarm --alarm-name "$1-auth-denied-spike" \
    --alarm-description "10+ rejected (401/403) requests in 5 minutes: possible token guessing or role probing" \
    --namespace "$2" --metric-name AuthDenied --statistic Sum --period 300 --evaluation-periods 1 \
    --threshold 10 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching && ok "alarm $1-auth-denied-spike"
  aws cloudwatch put-metric-alarm --alarm-name "$1-server-errors" \
    --alarm-description "Any 5xx / unhandled error in 5 minutes" \
    --namespace "$2" --metric-name ServerErrors --statistic Sum --period 300 --evaluation-periods 1 \
    --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching && ok "alarm $1-server-errors"
}
