# Run any AWS CLI command against Floci on this PC, through the shelter-tools container.
# Usage (from the repo folder):
#   .\infra\aws.ps1 dynamodb scan --table-name ShelterVisits --output table
#   .\infra\aws.ps1 cognito-idp admin-add-user-to-group --user-pool-id <pool> --username adopter2@shelter.test --group-name Staff
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
$ErrorActionPreference = 'Stop'
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
$docker = if ($dockerCommand) { $dockerCommand.Source } else {
  @((Join-Path $env:USERPROFILE 'AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $docker) { throw 'Docker Desktop CLI not found. Start Docker Desktop and open a new terminal.' }
& $docker run --rm -e AWS_ENDPOINT_URL=http://host.docker.internal:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test `
  -e AWS_DEFAULT_REGION=us-east-1 -e AWS_PAGER= shelter-tools aws @AwsArgs