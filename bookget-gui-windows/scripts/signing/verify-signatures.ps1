[CmdletBinding()]
param(
  [string]$ArtifactsDir = "release",
  [switch]$IncludeDlls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-SignToolPath {
  if ($env:WIN_SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:WIN_SIGNTOOL_PATH)) {
    return (Resolve-Path -LiteralPath $env:WIN_SIGNTOOL_PATH).Path
  }

  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw "signtool.exe not found. Install Windows 10/11 SDK or set WIN_SIGNTOOL_PATH."
}

function Get-FilesToVerify {
  param(
    [string]$BaseDir,
    [switch]$WithDlls
  )

  $patterns = @(
    "BookGet-GUI-Windows-Setup-*.exe",
    "BookGet-GUI-Windows-Portable-*.exe"
  )
  $files = @()
  foreach ($pattern in $patterns) {
    $files += Get-ChildItem -Path $BaseDir -File -Filter $pattern -ErrorAction SilentlyContinue
  }

  $innerExe = @(
    Join-Path $BaseDir "win-unpacked\*.exe",
    Join-Path $BaseDir "win-arm64-unpacked\*.exe"
  )
  foreach ($glob in $innerExe) {
    $files += Get-ChildItem -Path $glob -File -ErrorAction SilentlyContinue
  }

  if ($WithDlls) {
    $innerDll = @(
      Join-Path $BaseDir "win-unpacked\*.dll",
      Join-Path $BaseDir "win-arm64-unpacked\*.dll"
    )
    foreach ($glob in $innerDll) {
      $files += Get-ChildItem -Path $glob -File -ErrorAction SilentlyContinue
    }
  }

  return $files | Sort-Object FullName -Unique
}

if (-not (Test-Path -LiteralPath $ArtifactsDir)) {
  throw "Artifacts directory not found: $ArtifactsDir"
}

$signtool = Resolve-SignToolPath
$targets = Get-FilesToVerify -BaseDir $ArtifactsDir -WithDlls:$IncludeDlls
if (-not $targets.Count) {
  throw "No artifacts found under $ArtifactsDir"
}

foreach ($file in $targets) {
  Write-Host "Verifying: $($file.FullName)"
  & $signtool verify /pa /all /v $file.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verify failed: $($file.FullName)"
  }
}

Write-Host "Verification completed for $($targets.Count) file(s)."
