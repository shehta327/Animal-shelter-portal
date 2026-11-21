#!/usr/bin/env bash
# Cloud configuration review (run after everything is deployed):
#   .\infra\run.ps1 ../tests/cloud-checks.sh      or      bash tests/cloud-checks.sh
# Checks least privilege, no secrets in Lambda settings, private photo bucket,
# logging retention, metric filters and alarms, and prints the alarm states.
cd "$(dirname "$0")/.." || exit 1
. infra/common.sh
pass=0; fail=0
check() { if [ "$2" = "ok" ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1 ($2)"; fi; }

for FN in shelter-animals-api shelter-applications-api shelter-visits-api; do
  VARS=$(aws lambda get-function-configuration --function-name $FN --query 'Environment.Variables' --output json 2> /dev/null)
  if [ -z "$VARS" ]; then check "$FN deployed" "missing"; continue; fi
  echo "$VARS" | grep -Eiq 're_[A-Za-z0-9]{16}|postgres(ql)?://|"(DATABASE_URL|RESEND_API_KEY|AWS_SECRET_ACCESS_KEY)"' \
    && check "$FN: no secrets in environment variables" "secret-like value present" || check "$FN: no secrets in environment variables" ok
  ROLE=$(aws lambda get-function-configuration --function-name $FN --query Role --output text | sed 's#.*/##')
  POL=$(aws iam get-role-policy --role-name "$ROLE" --policy-name "$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[0]' --output text)" --output json 2> /dev/null)
  echo "$POL" | grep -Eq '"Action": *"\*"|"Resource": *"\*"|"[a-z]+:\*"' && check "$FN: role $ROLE has no wildcard actions/resources" "wildcard found" || check "$FN: role $ROLE has no wildcard actions/resources" ok
  [ "$(aws iam list-attached-role-policies --role-name "$ROLE" --query 'length(AttachedPolicies)' --output text)" = "0" ] \
    && check "$FN: no broad managed policies attached" ok || check "$FN: no broad managed policies attached" "managed policy attached"
  RET=$(aws logs describe-log-groups --log-group-name-prefix /aws/lambda/$FN --query 'logGroups[0].retentionInDays' --output text)
  [ "$RET" = "14" ] && check "$FN: log retention 14 days" ok || check "$FN: log retention 14 days" "$RET"
  N=$(aws logs describe-metric-filters --log-group-name /aws/lambda/$FN --query 'length(metricFilters)' --output text)
  [ "${N:-0}" -ge 2 ] && check "$FN: AuthDenied + ServerErrors metric filters" ok || check "$FN: metric filters" "$N found"
done

aws s3api get-public-access-block --bucket shelter-animal-photos --query 'PublicAccessBlockConfiguration.BlockPublicPolicy' --output text 2> /dev/null | grep -qi true \
  && check "photo bucket blocks public access" ok || check "photo bucket blocks public access" "not set"
aws cognito-idp describe-user-pool-client --user-pool-id "$(pool_id)" --client-id "$(client_id "$(pool_id)")" --query 'UserPoolClient.ClientSecret' --output text | grep -q None \
  && check "Cognito web client has no secret (public client)" ok || check "Cognito web client has no secret" "secret present"

echo; echo "Alarms:"; aws cloudwatch describe-alarms --alarm-name-prefix shelter- --query 'MetricAlarms[].[AlarmName,StateValue]' --output text | sed 's/^/   /'
echo; echo "$pass passed, $fail failed"
