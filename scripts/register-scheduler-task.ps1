param(
  [string]$TaskName = "RyokuyuScheduler",
  [int]$IntervalMinutes = 1
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
if (-not $node) { throw "node.exe was not found in PATH." }

# Run via wscript so no console window appears.
$runner = "wscript.exe"

$action = New-ScheduledTaskAction `
  -Execute $runner `
  -Argument "`"$root\scripts\run-scheduled.vbs`"" `
  -WorkingDirectory $root

# Repeat every N minutes, indefinitely (no duration).
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$trigger.Repetition.StopAtDurationEnd = $false

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "Registered: $TaskName (every $IntervalMinutes minute(s))"
Write-Host "Check : Get-ScheduledTask -TaskName $TaskName"
Write-Host "Remove: powershell -ExecutionPolicy Bypass -File scripts\unregister-scheduler-task.ps1"
Write-Host ""
Write-Host "Note: the task runs while you are logged on and the PC is awake."
