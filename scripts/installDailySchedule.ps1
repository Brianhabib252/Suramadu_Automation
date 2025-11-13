[CmdletBinding()]
param(
  [string]$TaskName = "SuramaduAutomationDaily",
  [string]$DailyTime = "22:00",
  [string]$Workflow = "examples/suramadu-auto-review.yaml",
  [string]$AdditionalArgs = ""
)

$ErrorActionPreference = 'Stop'

if ($DailyTime -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') {
  throw "DailyTime must use 24-hour HH:mm format (e.g. 20:00)."
}

$scriptRoot = Split-Path -Path $PSCommandPath -Parent
$runnerScript = Resolve-Path (Join-Path $scriptRoot "runSuramaduAutomation.ps1")

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`" -Workflow `"$Workflow`""
if ($AdditionalArgs) {
  $actionArgs += " -AdditionalArgs `"$AdditionalArgs`""
}
$taskCommand = "powershell.exe $actionArgs"

& schtasks.exe /Create /TN $TaskName /SC DAILY /ST $DailyTime /TR "$taskCommand" /F | Out-Null

Write-Host "Scheduled task '$TaskName' will run daily at $DailyTime using $Workflow."
Write-Host "Edit or remove the task anytime via Task Scheduler (taskschd.msc)."
