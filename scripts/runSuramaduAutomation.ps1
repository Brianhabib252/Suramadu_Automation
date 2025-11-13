[CmdletBinding()]
param(
  [string]$Workflow = "examples/suramadu-auto-review.yaml",
  [string]$AdditionalArgs = ""
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Path $PSCommandPath -Parent
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
$logDir = Join-Path $repoRoot "scheduler-logs"
if (-not (Test-Path $logDir)) {
  New-Item -Path $logDir -ItemType Directory | Out-Null
}
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "run-$timestamp.log"

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format o), $Message
  $line | Tee-Object -FilePath $logPath -Append | Out-Null
}

function ConvertToArgumentArray {
  param([string]$Raw)
  if (-not $Raw) {
    return @()
  }
  $errors = @()
  $tokens = [System.Management.Automation.PSParser]::Tokenize($Raw, [ref]$errors)
  if ($errors.Count -gt 0) {
    throw "Unable to parse AdditionalArgs: $($errors[0].Message)"
  }
  return $tokens |
    Where-Object { $_.Type -in @('String', 'CommandArgument') } |
    ForEach-Object { $_.Content }
}

$runnerArgs = @("run", "dev", "--")
$runnerArgs += ConvertToArgumentArray -raw $AdditionalArgs
$runnerArgs += $Workflow

Push-Location -Path $repoRoot
try {
  Write-Log "Starting automation run..."
  & npm @runnerArgs 2>&1 | Tee-Object -FilePath $logPath -Append
  $exitCode = $LASTEXITCODE
  Write-Log "Automation completed with exit code $exitCode."
  if ($exitCode -ne 0) {
    throw "Automation failed with exit code $exitCode. See $logPath for details."
  }
} finally {
  Pop-Location
}
