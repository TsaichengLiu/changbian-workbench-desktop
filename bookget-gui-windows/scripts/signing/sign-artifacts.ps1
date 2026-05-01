[CmdletBinding()]
param(
  [string]$ArtifactsDir = "release",
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [string]$CertPath = $env:WIN_CERT_PATH,
  [string]$CertPassword = $env:WIN_CERT_PASSWORD,
  [string]$CertSha1 = $env:WIN_CERT_SHA1,
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

  $roots = @(
    "C:\Program Files (x86)\Windows Kits\10\bin",
    "C:\Program Files (x86)\Microsoft SDKs\ClickOnce\SignTool"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -File -Filter signtool.exe -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw "signtool.exe not found. Install Windows 10/11 SDK or set WIN_SIGNTOOL_PATH."
}

function Get-FilesToSign {
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

if (-not $CertPath -and -not $CertSha1) {
  throw "Missing certificate info. Set WIN_CERT_PATH (+ WIN_CERT_PASSWORD) or WIN_CERT_SHA1."
}

if ($CertPath -and -not (Test-Path -LiteralPath $CertPath)) {
  throw "Certificate file not found: $CertPath"
}

$signtool = Resolve-SignToolPath
Write-Host "Using signtool: $signtool"

$targets = Get-FilesToSign -BaseDir $ArtifactsDir -WithDlls:$IncludeDlls
if (-not $targets.Count) {
  throw "No artifacts found under $ArtifactsDir"
}

foreach ($file in $targets) {
  $args = @(
    "sign",
    "/fd", "SHA256",
    "/tr", $TimestampUrl,
    "/td", "SHA256",
    "/v"
  )

  if ($CertPath) {
    $args += @("/f", $CertPath)
    if ($CertPassword) {
      $args += @("/p", $CertPassword)
    }
  } else {
    $args += @("/sha1", $CertSha1)
  }

  $args += $file.FullName

  Write-Host "Signing: $($file.FullName)"
  & $signtool @args
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for: $($file.FullName)"
  }
}

Write-Host "Signing completed for $($targets.Count) file(s)."
