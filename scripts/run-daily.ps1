# inbox/ のメモを1件ずつ処理する（タスクスケジューラ用）
# 既定は下書き作成のみ。自動公開する場合は config.json の run.autoPublish を true にするか、-Auto を付ける。

param(
  [switch]$Auto,
  [switch]$NoAi
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 日本語の文字化け防止（Windows PowerShell 5.1 対策）
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

# .env を読み込む
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $matches[1]
      $value = $matches[2].Trim()
      if (-not [Environment]::GetEnvironmentVariable($name)) {
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
      }
    }
  }
}

$argsList = @("src/cli.mjs", "run")
if ($Auto) { $argsList += "--auto" }
if ($NoAi) { $argsList += "--no-ai" }

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "run.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$output = & node @argsList 2>&1 | Out-String
Write-Host $output

$entry = "=== $stamp ===`r`n$output"
Add-Content -Path $logFile -Value $entry -Encoding UTF8
