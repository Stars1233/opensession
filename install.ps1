#Requires -Version 5.1
<#
Open Session installer for Windows.

  irm https://raw.githubusercontent.com/tellahq/opensession/main/install.ps1 | iex

Gets a Windows machine to a working `opensession` command: installs Bun if
needed, clones the source, installs dependencies, and puts an
`opensession.cmd` shim on the user PATH.

Windows support is Runner-first: this machine can attach to an Open Session
server as a trusted Runner (`opensession connect`). Running the server itself
on Windows is not supported; keep the server on Linux or macOS.

Safe to re-run: an existing install is fast-forwarded, never clobbered.

Parameters (also settable as environment variables):
  -Dir <path>      OPENSESSION_DIR      install location
  -Repo <url>      OPENSESSION_REPO     source repository
  -Channel <ref>   OPENSESSION_CHANNEL  branch or tag to track
  -NoModifyPath    NO_MODIFY_PATH=1     do not touch the user PATH
  -Uninstall                            remove the shim and the Runner task
#>
[CmdletBinding()]
param(
  [string]$Dir,
  [string]$Repo,
  [string]$Channel,
  [switch]$NoModifyPath,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$OpensessionHome = if ($env:OPENSESSION_HOME) { $env:OPENSESSION_HOME } else { Join-Path $env:USERPROFILE ".opensession" }
if (-not $Dir) { $Dir = if ($env:OPENSESSION_DIR) { $env:OPENSESSION_DIR } else { Join-Path $OpensessionHome "src" } }
if (-not $Repo) { $Repo = if ($env:OPENSESSION_REPO) { $env:OPENSESSION_REPO } else { "https://github.com/tellahq/opensession.git" } }
if (-not $Channel -and $env:OPENSESSION_CHANNEL) { $Channel = $env:OPENSESSION_CHANNEL }
if ($env:NO_MODIFY_PATH -eq "1") { $NoModifyPath = $true }
$BinDir = Join-Path $OpensessionHome "bin"

function Step([string]$m) { Write-Host "`n$m" -ForegroundColor White }
function Good([string]$m) { Write-Host "  ok      $m" -ForegroundColor Green }
function Muted([string]$m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Caution([string]$m) { Write-Host "  warn    $m" -ForegroundColor Yellow }
function Die([string]$m) { Write-Host "  error   $m" -ForegroundColor Red; exit 1 }

# -- uninstall ---------------------------------------------------------------

if ($Uninstall) {
  Step "Uninstalling Open Session"
  # The Runner scheduled task, if `opensession connect` installed one.
  schtasks /Delete /TN OpenSessionRunner /F 2>$null | Out-Null
  if (Test-Path $BinDir) {
    Remove-Item -Recurse -Force $BinDir
    Good "shim removed from $BinDir"
  }
  Muted "left in place (delete by hand if you mean it):"
  Muted "  $Dir  the checkout"
  Muted "  $(Join-Path $OpensessionHome 'runner.json')  the Runner credential"
  exit 0
}

Write-Host ""
Step "Open Session"
Muted "source      $Repo$(if ($Channel) { " ($Channel)" })"
Muted "install to  $Dir"
Muted "command     $(Join-Path $BinDir 'opensession.cmd')"

# -- prerequisites -----------------------------------------------------------

Step "Prerequisites"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Muted "installing Git ..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  }
  # winget writes a PATH this process has not read yet.
  $gitDefault = Join-Path $env:ProgramFiles "Git\cmd"
  if (Test-Path (Join-Path $gitDefault "git.exe")) { $env:Path = "$gitDefault;$env:Path" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "git is required. Install it from https://git-scm.com and re-run."
  }
}
Good ("git " + ((git --version) -replace "git version ", ""))

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Muted "installing Bun ..."
  try { Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression } catch { Die "could not install Bun. See https://bun.sh" }
  $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
  if (Test-Path (Join-Path $bunBin "bun.exe")) { $env:Path = "$bunBin;$env:Path" }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Die "Bun installed but not on PATH. Open a new terminal and re-run."
  }
}
Good ("bun " + (bun --version))

# -- source ------------------------------------------------------------------

Step "Source"
if (Test-Path (Join-Path $Dir ".git")) {
  git -C $Dir fetch --quiet origin
  $target = if ($Channel) { $Channel } else { git -C $Dir rev-parse --abbrev-ref HEAD }
  $dirty = git -C $Dir status --porcelain
  if ($dirty) {
    Caution "local changes present, leaving the checkout alone"
  } else {
    git -C $Dir merge --ff-only --quiet "origin/$target" 2>$null
    if ($LASTEXITCODE -eq 0) { Good ("updated to " + (git -C $Dir rev-parse --short HEAD)) }
    else { Caution "could not fast-forward, leaving the checkout alone" }
  }
} else {
  if (Test-Path $Dir) { Die "$Dir exists but is not a git checkout. Move it or pass -Dir." }
  New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
  $cloneArgs = @("--quiet")
  if ($Channel) { $cloneArgs += @("--branch", $Channel) }
  git clone @cloneArgs $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Die "could not clone $Repo" }
  Good "cloned to $Dir"
}

Step "Dependencies"
Push-Location $Dir
try {
  bun install --silent
  if ($LASTEXITCODE -ne 0) { Die "bun install failed" }
} finally { Pop-Location }
Good "installed"

# -- shim --------------------------------------------------------------------

Step "Command"
New-Item -ItemType Directory -Force $BinDir | Out-Null
$bunExe = (Get-Command bun).Source
$bunDir = Split-Path $bunExe
$shim = @"
@echo off
rem Generated by the Open Session installer. Safe to delete; re-run install.ps1.
set "PATH=$bunDir;%PATH%"
"$bunExe" "$Dir\scripts\cli.ts" %*
"@
# ANSI so cmd.exe reads a profile path with accents correctly under PS 5.
Set-Content -Path (Join-Path $BinDir "opensession.cmd") -Value $shim -Encoding Default
Good "opensession -> $Dir\scripts\cli.ts"

# -- PATH --------------------------------------------------------------------

function Broadcast-EnvironmentChange {
  try {
    if (-not ("OpenSession.NativeMethods" -as [type])) {
      Add-Type -Namespace OpenSession -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $HWND_BROADCAST = [IntPtr]0xffff
    $WM_SETTINGCHANGE = 0x001A
    $SMTO_ABORTIFHUNG = 0x0002
    [UIntPtr]$result = [UIntPtr]::Zero
    $sent = [OpenSession.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$result)
    return $sent -ne [IntPtr]::Zero
  } catch {
    return $false
  }
}

if (-not $NoModifyPath) {
  # Registry, not setx: setx truncates values over 1024 characters, which on a
  # developer machine is a real risk of destroying the PATH.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $current = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = $current -split ";" | Where-Object { $_ }
    if ($parts -notcontains $BinDir) {
      $next = if ($current) { "$current;$BinDir" } else { $BinDir }
      # ExpandString keeps any %VAR% entries other tools wrote expandable.
      $key.SetValue("Path", $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # A registry write alone is not enough: Explorer launches every new
      # terminal from its own cached environment block, which only refreshes on
      # WM_SETTINGCHANGE (what setx broadcasts) or at sign-out. Without this a
      # freshly opened terminal still has no opensession until the next logon.
      if (Broadcast-EnvironmentChange) {
        Good "added to the user PATH (new terminals pick it up)"
      } else {
        Good "added to the user PATH"
        Muted "  could not notify running programs; sign out and back in before opening a new terminal"
      }
    } else {
      Good "already on the user PATH"
    }
  } finally { $key.Close() }
}
# GitHub Actions needs PATH additions written to a file rather than exported.
if ($env:GITHUB_PATH) { Add-Content $env:GITHUB_PATH $BinDir }
$env:Path = "$BinDir;$env:Path"

# -- done --------------------------------------------------------------------

Step "Done"
Write-Host "  opensession connect --server <url> --code <code>   attach this machine as a Runner"
Write-Host "  opensession runner status                          is this machine attached?"
Muted "pairing is tailnet-gated: install Tailscale for Windows first (https://tailscale.com/download/windows)"
Muted "the Open Session server itself runs on Linux or macOS; this install is the Runner client"
Write-Host ""
