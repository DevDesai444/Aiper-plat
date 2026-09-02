<#
  Aiper — one-shot setup for a Windows machine.

  Installs what is missing, clones Aiper to the Desktop, configures it, and starts it.
  Safe to run again: an existing clone is updated rather than replaced, and anything already
  installed is left alone.

  Run it with:

      irm https://raw.githubusercontent.com/DevDesai444/Aiper/main/scripts/setup-windows.ps1 | iex

  Overrides, if ever needed, are environment variables rather than parameters — a param block
  behaves inconsistently when a script is piped into iex, and this script is meant to be run
  exactly that way:

      $env:AIPER_GITHUB_CLIENT_ID = 'Ov23...'
      $env:AIPER_TARGET = 'C:\dev\Aiper'
#>

# Native tools such as git write progress to stderr. Under 'Stop' some PowerShell hosts treat
# that as a terminating error, which would abort a perfectly good clone, so ordinary output is
# not allowed to be fatal — failures are checked explicitly through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'

# Public by design: the device flow has no client secret, and any client id ships inside the
# desktop app anyway, so this is not something that can be kept private.
$ClientId = if ($env:AIPER_GITHUB_CLIENT_ID) { $env:AIPER_GITHUB_CLIENT_ID } else { 'Ov23liGwgNrBrhj8UZP8' }
$RepoUrl  = if ($env:AIPER_REPO_URL) { $env:AIPER_REPO_URL } else { 'https://github.com/DevDesai444/Aiper.git' }
$Target   = if ($env:AIPER_TARGET) { $env:AIPER_TARGET } else { Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aiper' }

function Say  ($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Good ($m) { Write-Host "  $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Aiper setup" -ForegroundColor White
Write-Host "  ------------" -ForegroundColor DarkGray
Write-Host ""

function Have ($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

<#
  npm has to be invoked as npm.cmd, not npm.

  Typing `npm` in PowerShell resolves to npm.ps1, and on a machine with the default execution
  policy that file is refused: "running scripts is disabled on this system". npm.cmd is a batch
  file, which the execution policy does not govern, so it works without asking anyone to weaken
  a security setting they may not be allowed to change anyway.
#>
function Npm-Exe {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($guess in @(
    (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd'),
    (Join-Path $env:APPDATA 'npm\npm.cmd')
  )) { if ($guess -and (Test-Path $guess)) { return $guess } }
  return $null
}

# PATH is only refreshed for new processes, so a tool installed a moment ago stays invisible to
# this one until the process environment is re-read.
function Reload-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-Package ($id, $label) {
  if (-not (Have 'winget')) {
    Die "$label is missing, and winget is not available to install it. Install $label by hand, then run this again."
  }
  Say "Installing $label. This can take a couple of minutes..."
  winget install --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  Reload-Path
}

# ---------------------------------------------------------------------------- prerequisites
if (Have 'git') { Good "Git is already installed." } else { Install-Package 'Git.Git' 'Git' }
if (-not (Have 'git')) { Die "Git is installed but not on PATH yet. Close this window, open a new PowerShell, and run this again." }

$nodeOk = $false
if (Have 'node') {
  $major = ((node -v) -replace '^v', '').Split('.')[0] -as [int]
  if ($major -ge 20) { Good "Node $(node -v) is already installed."; $nodeOk = $true }
  else { Warn "Node $(node -v) is too old; Aiper needs 20 or newer." }
}
if (-not $nodeOk) { Install-Package 'OpenJS.NodeJS.LTS' 'Node.js' }
if (-not (Have 'node')) { Die "Node is installed but not on PATH yet. Close this window, open a new PowerShell, and run this again." }
$npm = Npm-Exe
if (-not $npm) { Die "npm is missing even though Node is present. Reinstall Node.js." }

# ----------------------------------------------------------------------------------- source
if (Test-Path (Join-Path $Target '.git')) {
  Say "Updating the existing copy at $Target"
  $dirty = git -C $Target status --porcelain 2>$null
  if ([string]::IsNullOrWhiteSpace(($dirty | Out-String))) {
    git -C $Target pull --ff-only 2>&1 | Out-Null
  } else {
    # Local edits belong to whoever made them; overwriting them is not this script's business.
    Warn "There are local changes here, so the update was skipped and they were left alone."
  }
} else {
  Say "Cloning Aiper to $Target"
  git clone --depth 1 $RepoUrl $Target 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "Could not clone $RepoUrl. Check the network and that the address is right." }
}
if (-not (Test-Path (Join-Path $Target 'package.json'))) { Die "$Target does not look like the Aiper source." }
Good "Source is ready."

if ($Target -like '*OneDrive*') {
  Warn "This folder is inside OneDrive, which will try to sync the thousands of files npm installs."
  Warn "It will still work, but if it becomes slow, move the folder somewhere outside OneDrive."
}

Set-Location $Target

# ------------------------------------------------------------------------------------ config
# .env is gitignored, so it never arrives with a clone and has to be written here.
$envPath = Join-Path $Target '.env'
$configured = (Test-Path $envPath) -and ((Get-Content $envPath -Raw -ErrorAction SilentlyContinue) -match 'AIPER_GITHUB_CLIENT_ID=\S')
if ($configured) {
  Good "A client id is already configured; leaving it alone."
} else {
  # Written without a byte-order mark: the id is read by a small hand-rolled parser, and a BOM
  # would end up inside the value itself.
  [IO.File]::WriteAllText($envPath, "AIPER_GITHUB_CLIENT_ID=$ClientId`n", (New-Object Text.UTF8Encoding $false))
  Good "Wrote .env"
}

# --------------------------------------------------------------------------------- install
Say "Installing dependencies. The first run takes a few minutes..."
& $npm install --no-fund --no-audit

# Checked by looking at the result, not at $LASTEXITCODE. A PowerShell-level failure — an
# execution policy refusing a script, say — never sets an exit code, so the previous version of
# this check read a stale value and announced success over a failed install.
$installed = Test-Path (Join-Path $Target 'node_modules\electron')
if (-not $installed) { Die "npm install did not complete. The reason is above." }
Good "Dependencies installed."

Write-Host ""
Good "Starting Aiper. Click 'Sign in with GitHub' and approve the code it shows you."
Write-Host "  Next time:  cd `"$Target`"  then  npm.cmd run dev" -ForegroundColor DarkGray
Write-Host ""

& $npm run dev
