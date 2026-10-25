# Windows タスクスケジューラに毎日の実行を登録する
# 例: .\scripts\register-task.ps1 -Time 18:00
#     .\scripts\register-task.ps1 -Time 18:00 -Auto   （生成と同時に公開）

param(
  [string]$Time = "18:00",
  [switch]$Auto,
  [string]$TaskName = "RyokuyuAutoPost"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$script = Join-Path $root "scripts\run-daily.ps1"

$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
if ($Auto) { $arg += " -Auto" }

$action = "powershell.exe $arg"

schtasks /Create /TN $TaskName /SC DAILY /ST $Time /TR $action /F
if ($LASTEXITCODE -ne 0) { throw "タスクの登録に失敗しました" }

Write-Host "登録しました: $TaskName （毎日 $Time）"
Write-Host "確認: schtasks /Query /TN $TaskName"
Write-Host "削除: schtasks /Delete /TN $TaskName /F"
