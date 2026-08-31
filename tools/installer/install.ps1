<#
.SYNOPSIS
Installs the Confidential Router gatekeeper from GitHub Releases.

.DESCRIPTION
The one-liner form, which is what the console's Gatekeeper page shows:

    irm https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.ps1 | iex

`iex` compiles the text into a script block, so the parameters below keep their
defaults there; set the matching `$env:` variable to override one. Downloaded as
a file, the script takes them as ordinary parameters.

.PARAMETER Version
0.1.0, v0.1.0, gatekeeper-v0.1.0 or nightly. Defaults to the latest release.

.PARAMETER InstallDir
Where gatekeeper.exe lands. Defaults to %LOCALAPPDATA%\Programs\gatekeeper,
which needs no elevation and is added to the user PATH.

.PARAMETER BaseUrl
The release download root. https:// or file://, the latter for a mirror or an
offline copy of the release directory.

.EXAMPLE
.\install.ps1 -Version 0.1.0 -InstallDir C:\tools
#>
param(
  [string] $Version = $env:GATEKEEPER_VERSION,
  [string] $InstallDir = $env:GATEKEEPER_INSTALL_DIR,
  [string] $Repo = $(if ($env:GATEKEEPER_REPO) { $env:GATEKEEPER_REPO } else { 'Super-Protocol/confidential-router' }),
  [string] $BaseUrl = $env:GATEKEEPER_BASE_URL,
  [string] $ApiUrl = $(if ($env:GATEKEEPER_API_URL) { $env:GATEKEEPER_API_URL } else { 'https://api.github.com' })
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 still negotiates TLS 1.0 by default, which github.com
# refuses. Harmless on PowerShell 7, where the property already includes it.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Releases are tagged `gatekeeper-v<semver>`: this is a monorepo and the router
# will get tags of its own.
$TagPrefix = 'gatekeeper-'

# Turns whatever the caller typed into the release's git tag. `nightly` is the
# rolling pre-release and carries no `v`.
function Get-ReleaseTag([string] $Ref) {
  $bare = $Ref -replace "^$TagPrefix", ''
  if ($bare -match '^\d') { $bare = "v$bare" }
  return "$TagPrefix$bare"
}

# What the archive name carries: `gatekeeper-v0.1.0` -> `0.1.0`.
function Get-VersionToken([string] $Tag) {
  $bare = $Tag -replace "^$TagPrefix", ''
  if ($bare -match '^v\d') { return $bare.Substring(1) }
  return $bare
}

# `releases/latest` never points at a pre-release, so the nightly cannot be
# installed by accident.
function Get-LatestTag {
  $url = "$($ApiUrl.TrimEnd('/'))/repos/$Repo/releases/latest"
  $headers = @{ 'User-Agent' = 'confidential-router'; 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
  try {
    return (Invoke-RestMethod -Uri $url -Headers $headers).tag_name
  } catch {
    throw "could not reach $url - pass -Version to install a specific release ($($_.Exception.Message))"
  }
}

# Windows on ARM runs the amd64 build under emulation; no arm64 archive is
# published (apps/gatekeeper/.goreleaser.yaml).
function Get-Arch {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { return 'amd64' }
    'ARM64' {
      Write-Host 'No windows/arm64 build is published; installing the amd64 one, which Windows emulates.'
      return 'amd64'
    }
    default { return 'amd64' }
  }
}

# Fetches one release file. A file: base URL is how a mirror, an air-gapped
# copy, or the release workflow's smoke test hands over artifacts it already
# has; Invoke-WebRequest does not speak that scheme, so it is copied instead.
function Get-Release([string] $Uri, [string] $OutFile) {
  if ($Uri -like 'file:*') {
    $path = ([uri] $Uri).LocalPath
    if (-not (Test-Path -LiteralPath $path)) { throw "not found: $path" }
    Copy-Item -LiteralPath $path -Destination $OutFile -Force
    return
  }
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

# GoReleaser's `checksums.txt` is `<hex>  <filename>` per line.
function Get-ExpectedHash([string] $Path, [string] $Name) {
  foreach ($line in Get-Content -LiteralPath $Path) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].Trim().TrimStart('*') -eq $Name) { return $parts[0] }
  }
  return $null
}

$tag = if ($Version) { Get-ReleaseTag $Version } else { Get-LatestTag }
if (-not $tag) { throw "no release found for $Repo - pass -Version to install a specific release" }
$versionToken = Get-VersionToken $tag
$arch = Get-Arch
$name = "gatekeeper_${versionToken}_windows_${arch}.zip"

if (-not $BaseUrl) { $BaseUrl = "https://github.com/$Repo/releases/download" }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\gatekeeper' }

Write-Host "Installing gatekeeper $versionToken (windows/$arch) from $tag"

$work = Join-Path ([IO.Path]::GetTempPath()) ("gatekeeper-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $root = $BaseUrl.TrimEnd('/')
  $archive = Join-Path $work $name
  $checksums = Join-Path $work 'checksums.txt'
  # Progress rendering makes Invoke-WebRequest an order of magnitude slower on
  # Windows PowerShell, and this runs unattended more often than not.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Get-Release "$root/$tag/$name" $archive
    Get-Release "$root/$tag/checksums.txt" $checksums
  } finally {
    $ProgressPreference = $progress
  }

  # A missing entry is as disqualifying as a wrong one: nothing is installed
  # that checksums.txt does not account for.
  $want = Get-ExpectedHash $checksums $name
  if (-not $want) { throw "$name is not listed in checksums.txt" }
  $got = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  if ($want.ToLowerInvariant() -ne $got.ToLowerInvariant()) {
    throw "checksum mismatch for ${name}: expected $want, actual $got"
  }
  Write-Host 'Checksum OK'

  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'unpacked') -Force
  $exe = Join-Path $work 'unpacked\gatekeeper.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "$name does not contain gatekeeper.exe" }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $target = Join-Path $InstallDir 'gatekeeper.exe'
  Copy-Item -LiteralPath $exe -Destination $target -Force
  Write-Host "Installed $target"

  & $target version

  # HKCU only: a per-user install has no business rewriting the machine PATH,
  # and this is the one place the script touches anything persistent. The
  # registry-backed 'User' scope exists on Windows alone, so on any other host
  # -- PowerShell 7 on Linux, which is where this script is tested -- the
  # install still happens and only the PATH entry is skipped.
  if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
    if ($entries -notcontains $InstallDir) {
      [Environment]::SetEnvironmentVariable('Path', (($entries + $InstallDir) -join ';'), 'User')
      Write-Host "Added $InstallDir to your user PATH. Open a new terminal to pick it up."
    }
    if (($env:Path -split ';') -notcontains $InstallDir) {
      $env:Path = "$env:Path;$InstallDir"
    }
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
