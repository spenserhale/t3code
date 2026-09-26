# SECode installer for Windows. Clones or updates the `secode` branch into
# ~\.secode\src, installs dependencies, builds the desktop installer into
# ~\.secode\built, and runs it silently so SECode shows up in the Start menu.
# Run it again to update.
#
#   irm https://raw.githubusercontent.com/spenserhale/t3code/secode/install.ps1 | iex
#
# With options:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/spenserhale/t3code/secode/install.ps1))) -NoInstall
#
# or from any checkout: .\install.ps1 [-NoBuild] [-NoInstall]
#
# Layout:
#   ~\.secode\src     clone of spenserhale/t3code on `secode`, managed by this script
#   ~\.secode\built   the NSIS installer the build produced
#
# The app installs per user, under %LOCALAPPDATA%\Programs, with no admin rights.
# It never touches ~\.t3. SECode reads and writes that directory, the same one an
# official T3 Code install uses, so both see the same threads. Run one at a time.
#
# Needs git, Node (the major version package.json's engines field names), and
# for the build: Rust with the MSVC target, Visual Studio C++ build tools with
# the Spectre libraries, and Python. The build checks these first and names
# whatever is missing.
#
# Environment overrides: SECODE_HOME, SECODE_REPO, SECODE_BRANCH.
#
# macOS uses install.sh. This file lives on `fork-infra` and is merged into
# `secode`. It is fork-only and never goes upstream.
param(
  [switch]$NoBuild,
  [switch]$NoInstall,
  [switch]$Help
)

# `irm | iex` runs in the caller's scope; the child scope below keeps the
# error preference, working directory and PATH from leaking into their shell.
& {
$ErrorActionPreference = "Stop"

if ($Help) {
  if ($PSCommandPath) {
    Get-Content -LiteralPath $PSCommandPath -TotalCount 30 | ForEach-Object { $_ -replace '^# ?', '' }
  } else {
    Write-Host "Options: -NoBuild, -NoInstall. See the header of install.ps1 on the secode branch."
  }
  return
}

function Fail([string]$Message) { throw "error: $Message" }
function Step([string]$Message) { Write-Host ""; Write-Host "==> $Message" }
# Native commands do not throw on a non-zero exit, even with ErrorActionPreference Stop.
function Invoke-Checked([string]$What) {
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE)." }
}
function Get-OrDefault([string]$Value, [string]$Fallback) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $Fallback } else { return $Value }
}

$SecodeHome = Get-OrDefault $env:SECODE_HOME (Join-Path $HOME ".secode")
$SecodeRepo = Get-OrDefault $env:SECODE_REPO "https://github.com/spenserhale/t3code.git"
$SecodeBranch = Get-OrDefault $env:SECODE_BRANCH "secode"
$Src = Join-Path $SecodeHome "src"
$Built = Join-Path $SecodeHome "built"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is not installed." }

# --- source ---------------------------------------------------------------
# `secode` is rebuilt and force-pushed, so updating is a reset, not a pull.
# Local edits in ~\.secode\src would be lost, so refuse rather than discard.
if (Test-Path -LiteralPath (Join-Path $Src ".git")) {
  Step "updating $Src to origin/$SecodeBranch"
  $dirty = git -C $Src status --porcelain --untracked-files=no
  Invoke-Checked "git status"
  if ($dirty) {
    Fail "$Src has local changes. It is managed by this script; commit them elsewhere or discard them first."
  }
  git -C $Src fetch --quiet origin "+refs/heads/${SecodeBranch}:refs/remotes/origin/$SecodeBranch"
  Invoke-Checked "git fetch"
  git -C $Src checkout --quiet -B $SecodeBranch "origin/$SecodeBranch"
  Invoke-Checked "git checkout"
} else {
  if (Test-Path -LiteralPath $Src) { Fail "$Src exists but is not a git checkout. Move it away and re-run." }
  Step "cloning $SecodeRepo ($SecodeBranch) into $Src"
  New-Item -ItemType Directory -Force -Path $SecodeHome | Out-Null
  # node_modules paths can pass Windows' 260-character limit.
  git clone -c core.longpaths=true --branch $SecodeBranch --single-branch $SecodeRepo $Src
  Invoke-Checked "git clone"
}
# PATH is process-wide, so it is restored too.
$savedPath = $env:PATH
Push-Location -LiteralPath $Src
try {
Write-Host "at $(git log -1 --format='%h %s')"

# --- node -----------------------------------------------------------------
# Vite+ ships a Node that follows the repo's engines field; prefer it when present.
$vitePlusBin = Join-Path $HOME ".vite-plus\bin"
if (Test-Path -LiteralPath $vitePlusBin) { $env:PATH = "$vitePlusBin;$env:PATH" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is not installed. Install the version package.json's engines field names."
}
$package = Get-Content -Raw -LiteralPath (Join-Path $Src "package.json") | ConvertFrom-Json
$nodeMajor = (node -p "process.versions.node.split('.')[0]").Trim()
$wantMajor = (($package.engines.node -replace '[^0-9.]', '') -split '\.')[0]
if ($nodeMajor -ne $wantMajor) {
  Write-Warning "node $nodeMajor is on PATH, package.json asks for $wantMajor. The build may fail."
}

# --- pnpm -----------------------------------------------------------------
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    Fail "pnpm is missing and corepack is not available. Install pnpm, then re-run."
  }
  Write-Host "pnpm missing; enabling it through corepack"
  corepack enable
  if ($LASTEXITCODE -ne 0) {
    Fail "corepack enable failed; Node's folder may need admin rights. Run 'npm install -g pnpm', then re-run."
  }
}
# Best effort. Windows PowerShell turns redirected stderr into a terminating
# error under the Stop preference, so relax it for this one call.
$ErrorActionPreference = "Continue"
corepack prepare $package.packageManager --activate *> $null
$ErrorActionPreference = "Stop"

# --- dependencies ---------------------------------------------------------
Step "installing dependencies"
pnpm install
Invoke-Checked "pnpm install"
# The build script shells out to repo-local bins such as `vp`. pnpm scripts put
# node_modules\.bin on PATH themselves; plain `node` does not.
$env:PATH = "$(Join-Path $Src 'node_modules\.bin');$env:PATH"

if ($NoBuild) {
  Write-Host ""
  Write-Host "Dependencies installed in $Src. Skipped the desktop build (-NoBuild)."
  return
}

# --- build ----------------------------------------------------------------
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  "ARM64" { "arm64" }
  "AMD64" { "x64" }
  default { Fail "unsupported Windows architecture $env:PROCESSOR_ARCHITECTURE" }
}
$artifacts = Join-Path $Built "artifacts"
Step "building the desktop installer ($arch); this takes several minutes"
if (Test-Path -LiteralPath $artifacts) { Remove-Item -Recurse -Force -LiteralPath $artifacts }
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch $arch --output-dir $artifacts
Invoke-Checked "the desktop build"

$installer = Get-ChildItem -LiteralPath $artifacts -Filter "SECode-*.exe" -File | Select-Object -First 1
if (-not $installer) { Fail "the build produced no installer in $artifacts" }
Write-Host "built $($installer.FullName)"

# --- install --------------------------------------------------------------
# The NSIS installer is per user and one-click, so /S installs without prompts
# or admin rights and replaces an older SECode in place.
$installedTo = "not installed"
if (-not $NoInstall) {
  # Only processes started from an installed SECode, found by its install
  # folder, count; nothing is matched by name alone.
  $uninstallKeys = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  $existing = Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties["DisplayName"] -and $_.DisplayName -like "SECode*" } |
    Select-Object -First 1
  $running = @()
  if ($existing -and $existing.PSObject.Properties["InstallLocation"] -and $existing.InstallLocation) {
    $prefix = $existing.InstallLocation.TrimEnd('\') + '\'
    $running = @(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  }
  if ($running.Count -gt 0) {
    Write-Host ""
    Write-Host "SECode is running, so it was left alone. Quit it and run:"
    Write-Host "  & `"$($installer.FullName)`" /S"
  } else {
    Step "installing SECode for this user"
    $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
    if ($process.ExitCode -ne 0) { Fail "the installer failed (exit $($process.ExitCode))." }
    $installed = Get-ItemProperty -Path $uninstallKeys -ErrorAction SilentlyContinue |
      Where-Object { $_.PSObject.Properties["DisplayName"] -and $_.DisplayName -like "SECode*" } |
      Select-Object -First 1
    if ($installed -and $installed.PSObject.Properties["InstallLocation"]) {
      $installedTo = $installed.InstallLocation
    } else {
      $installedTo = "Start menu (install folder not found in the registry)"
    }
    Write-Host "installed $installedTo"
  }
}

Write-Host @"

SECode is installed.

  source   $Src ($SecodeBranch)
  build    $($installer.FullName)
  app      $installedTo

State lives in ~\.t3, shared with the official T3 Code: threads and settings
show up in both. Run one at a time, not both at once.

To update, run this installer again.
"@

} finally {
  Pop-Location
  $env:PATH = $savedPath
}
}
