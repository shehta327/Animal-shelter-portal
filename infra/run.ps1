# Runs an infra script for PCs without the AWS CLI, inside a small tool container
# (Node.js 24 + AWS CLI v2) that talks to Floci on this PC.
# Usage (PowerShell, from the repo folder):   .\infra\run.ps1 platform.sh
# With the AWS CLI and the Lab 7 "floci" profile you can instead run:  bash infra/platform.sh
param([Parameter(Mandatory = $true)][string]$Script, [string[]]$ScriptArgs = @())
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..").Path
docker image inspect shelter-tools *> $null
if ($LASTEXITCODE -ne 0) { docker build -t shelter-tools "$PSScriptRoot\tools" }
$tty = @(); if ($Script -like 'set-*') { $tty = @('-it') }   # prompts need a terminal
docker run --rm @tty -v "${repo}:/work" -w /work `
  -e AWS_ENDPOINT_URL=http://host.docker.internal:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test `
  -e AWS_DEFAULT_REGION=us-east-1 -e SEED_PASSWORD -e VISIT_LEAD_MINUTES -e SLOT_STEP_MINUTES -e REMINDER_MINUTES_BEFORE `
  shelter-tools bash "infra/$Script" @ScriptArgs
