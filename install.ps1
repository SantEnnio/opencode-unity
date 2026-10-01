<#
.SYNOPSIS
  Installs the opencode-unity plugin for the current user, from a GitHub release.

.DESCRIPTION
  Downloads the prebuilt package (no Bun, git or build tools needed) and copies it where opencode 1
  and opencode 2 load global plugins: %USERPROFILE%\.config\opencode\plugins. No administrator
  rights needed. Run it again to update.

  One line, in PowerShell:
    irm https://github.com/SantEnnio/opencode-unity/releases/latest/download/install.ps1 | iex

.PARAMETER Version
  Release tag to install, for example v0.2.0. Default: the latest release.

.PARAMETER Package
  Path to an opencode-unity-*.tgz already downloaded (offline install, or a shared drive).

.PARAMETER Uninstall
  Removes the plugin. Caches and config.json are left in place.
#>
param(
  [string]$Version = "",
  [string]$Package = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Repo = "SantEnnio/opencode-unity"

# Same rule as opencode: OPENCODE_CONFIG_DIR, else XDG_CONFIG_HOME\opencode, else ~\.config\opencode.
if ($env:OPENCODE_CONFIG_DIR) { $ConfigDir = $env:OPENCODE_CONFIG_DIR }
elseif ($env:XDG_CONFIG_HOME) { $ConfigDir = Join-Path $env:XDG_CONFIG_HOME "opencode" }
else { $ConfigDir = Join-Path (Join-Path $HOME ".config") "opencode" }

$PluginFile = Join-Path (Join-Path $ConfigDir "plugins") "opencode-unity.js"
$AssetsDir = Join-Path $ConfigDir "opencode-unity"

if ($Uninstall) {
  Remove-Item -Force -ErrorAction SilentlyContinue $PluginFile
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $AssetsDir "symbol-exporter"), (Join-Path $AssetsDir "unity-probe"), (Join-Path $AssetsDir "cli.js"), (Join-Path $AssetsDir "VERSION")
  Write-Host "opencode-unity removed from $ConfigDir (config.json and caches were left in place)."
  return
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-unity-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  if ($Package) {
    $Tarball = (Resolve-Path $Package).Path
  } else {
    # Windows PowerShell 5.1 does not enable TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($Version) { $Api = "https://api.github.com/repos/$Repo/releases/tags/$Version" }
    else { $Api = "https://api.github.com/repos/$Repo/releases/latest" }
    $Release = Invoke-RestMethod -Uri $Api -Headers @{ "User-Agent" = "opencode-unity-installer" }
    $Asset = $Release.assets | Where-Object { $_.name -like "opencode-unity-*.tgz" } | Select-Object -First 1
    if (-not $Asset) { throw "Release $($Release.tag_name) has no opencode-unity package attached." }
    $Tarball = Join-Path $Work $Asset.name
    Write-Host "Downloading $($Asset.name) ($($Release.tag_name))..."
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Tarball -UseBasicParsing
  }

  # tar.exe ships with Windows 10 1803 and later.
  & tar -xzf $Tarball -C $Work
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Tarball (tar exit code $LASTEXITCODE)." }
  $Unpacked = Join-Path $Work "package"
  foreach ($Needed in @("dist\index.js", "dist\cli.js", "bin\symbol-exporter\symbol-exporter.dll", "unity-probe\package.json", "package.json")) {
    if (-not (Test-Path (Join-Path $Unpacked $Needed))) { throw "The package is incomplete: $Needed is missing." }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $PluginFile), $AssetsDir | Out-Null
  Copy-Item -Force (Join-Path $Unpacked "dist\index.js") $PluginFile
  Copy-Item -Force (Join-Path $Unpacked "dist\cli.js") (Join-Path $AssetsDir "cli.js")
  $Exporter = Join-Path $AssetsDir "symbol-exporter"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Exporter
  Copy-Item -Recurse -Force (Join-Path $Unpacked "bin\symbol-exporter") $Exporter
  $Probe = Join-Path $AssetsDir "unity-probe"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Probe
  Copy-Item -Recurse -Force (Join-Path $Unpacked "unity-probe") $Probe
  $Installed = (Get-Content -Raw (Join-Path $Unpacked "package.json") | ConvertFrom-Json).version
  Set-Content -Path (Join-Path $AssetsDir "VERSION") -Value $Installed -Encoding Ascii
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}

Write-Host ""
Write-Host "opencode-unity $Installed installed:"
Write-Host "  plugin  $PluginFile"
Write-Host "  assets  $AssetsDir"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Warning "The .NET SDK is not on PATH. The plugin needs it to check the C# code. Install the .NET SDK 8 from https://dotnet.microsoft.com/download, then restart opencode."
}

Write-Host ""
Write-Host "Next: restart opencode, open a Unity project and type /unity."
