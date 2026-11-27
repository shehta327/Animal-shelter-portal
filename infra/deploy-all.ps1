# Deploys the whole portal to Floci in the right order, using the same scripts
# each owner runs on their own:
#   1. platform.sh        shared: Cognito, EventBridge bus, API Gateway, website bucket
#   2. Animals deploy.sh  first, because Applications and Visits call it
#   3. Applications deploy.sh
#   4. Visits deploy.sh
#   5. deploy-web.sh      website with the real API and Cognito IDs
#
#   .\infra\deploy-all.ps1           (from the repo root)
#   .\infra\deploy-all.ps1 -Seed     also adds the demo animals with photos
#
# Stops at the first step that fails and names it. Secrets are not touched:
# set them once with set-resend-key.sh / set-db-secret.sh as before.
param([switch]$Seed)
$repo = Split-Path -Parent $PSScriptRoot

$steps = @(
  @{ Name = 'Shared platform';        Dir = $repo;                                                  Script = 'platform.sh' },
  @{ Name = 'Animal Listings';        Dir = Join-Path $repo 'shelter-animals-service';              Script = 'deploy.sh' },
  @{ Name = 'Adoption Applications';  Dir = Join-Path $repo 'shelter-applications-service';         Script = 'deploy.sh' },
  @{ Name = 'Visit Scheduling';       Dir = Join-Path $repo 'shelter-visits-service';               Script = 'deploy.sh' },
  @{ Name = 'Website';                Dir = $repo;                                                  Script = 'deploy-web.sh' }
)

$i = 0
foreach ($s in $steps) {
  $i++
  Write-Host ""
  Write-Host "######## $i/$($steps.Count)  $($s.Name)  ($($s.Script))" -ForegroundColor Cyan
  Push-Location $s.Dir
  try {
    & .\infra\run.ps1 $s.Script
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
  } catch {
    Pop-Location
    Write-Host ""
    Write-Host "STOPPED at step $i ($($s.Name)): $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}

if ($Seed) {
  Write-Host ""
  Write-Host "######## Demo animals with photos" -ForegroundColor Cyan
  Push-Location $repo
  try { node infra\seed-animals.mjs; if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" } }
  catch { Pop-Location; Write-Host "Seeding failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  Pop-Location
}

Write-Host ""
Write-Host "All done. Website: http://localhost:4566/shelter-web/index.html" -ForegroundColor Green
