# WI-10003665 — PrepareToInstall helper (papercusp.iss StopWslPayloadHolders).
#
# Before BeginPayloadUpgrade renames {app}\sidecar|resources|seed aside, stop
# every process INSIDE the WSL distro that holds a handle under those roots
# (stop-wsl-payload-holders.sh does the work as root). Windows refuses to rename
# a directory with an open file in it, and the WSL-side operator is a detached
# daemon the role's .exe close does not reach.
#
# Bounded and never cold-boots WSL: a distro that is not running holds no
# handles, so it is skipped. Everything this does is written to -LogPath, which
# the installer copies into its own /LOG. Exit 0 = the payload is not held.
param(
  [Parameter(Mandatory = $true)][string] $AppDir,
  [Parameter(Mandatory = $true)][string] $ScriptDir,
  [Parameter(Mandatory = $true)][string] $LogPath,
  [string] $Distro = 'papercup-runtime',
  [int] $TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'

function Say([string] $Message) {
  Add-Content -LiteralPath $LogPath -Value $Message -Encoding UTF8
}

# Windows paths cannot contain '"'; a trailing '\' would escape the closing
# quote under CommandLineToArgvW, so strip it.
function Quote([string] $Path) {
  return '"' + $Path.TrimEnd('\') + '"'
}

try {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (-not (Test-Path -LiteralPath $wsl)) {
    Say 'skip: wsl.exe is not installed, so nothing can hold the payload'
    exit 0
  }
  $roots = @('sidecar', 'resources', 'seed' |
    ForEach-Object { Join-Path $AppDir $_ } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  if ($roots.Count -eq 0) {
    Say "skip: no payload roots under $AppDir"
    exit 0
  }
  # wsl.exe writes UTF-16LE unless WSL_UTF8=1; drop the NULs either way.
  $running = ((& $wsl --list --running --quiet 2>$null) | Out-String) -replace "`0", ''
  $isRunning = @($running -split "\r?\n" | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -eq $Distro }).Count -gt 0
  if (-not $isRunning) {
    Say "skip: distro $Distro is not running, so nothing in it holds the payload"
    exit 0
  }

  $arguments = "--distribution $Distro --user root --cd " + (Quote $ScriptDir) +
    ' --exec /bin/bash stop-wsl-payload-holders.sh ' +
    (($roots | ForEach-Object { Quote $_ }) -join ' ')
  Say "run: wsl.exe $arguments"
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $wsl
  $info.Arguments = $arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { }
    Say "fail: wsl.exe did not finish within $TimeoutSeconds s"
    exit 76
  }
  $process.WaitForExit()
  Say $stdout.Result.TrimEnd()
  if ($stderr.Result.Trim()) { Say $stderr.Result.TrimEnd() }
  Say "exit: $($process.ExitCode)"
  exit $process.ExitCode
} catch {
  Say ("fail: " + $_.Exception.Message)
  exit 77
}
