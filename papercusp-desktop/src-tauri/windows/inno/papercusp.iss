; Papercusp Windows installer — Inno Setup template (WI-3172).
;
; WHY INNO, NOT NSIS/MSI/7z-SFX: the owner-mandated FULL offline seed
; (git super.bundle + hive corestore) puts the Windows payload at ~3.4 GB —
; and makensis dies packaging it with "Internal compiler error #12345:
; error mmapping file ... out of range" at a ~2 GiB offset (signed-32-bit
; datablock limit; both roles failed at ~1.97 GiB on 2026-07-06). The
; corestore ALONE exceeds 2 GiB, so no sidecar slimming can rescue NSIS.
; MSI/WiX caps lower (~2 GB CAB). A 7z-SFX combined .exe hits the Windows
; ~2 GB PE-loader limit. Inno Setup 6.5.2+ removed its 2 GB limit: a single
; setup.exe is supported to ~4 GB, and DiskSpanning covers anything beyond.
;
; LAYOUT PARITY with the retired NSIS bundle (verified by 7z-listing a
; placeholder NSIS installer): papercusp-desktop.exe (UNrenamed — hooks.nsh
; and shortcut icons reference it) + sidecar/ + resources/ + seed/ at the
; install root, per-user under %LOCALAPPDATA%\<productName>. The app resolves
; resources relative to the exe dir (BaseDirectory::Resource), e.g.
; custom_protocol.rs "sidecar/spa", wsl_setup.rs "resources/<rootfs>".
;
; INVOCATION (bin/build-windows-on-vm.sh passes all defines):
;   ISCC /DAppId=com.papercusp.server "/DAppName=Papercusp Server" \
;        /DAppVersion=<ver> /DBuildRoot=<...>\src-tauri /O<outdir> papercusp.iss
;
; Auto-updater note: Tauri's Windows updater expected the NSIS artifact; the
; Inno cutover leaves Windows on manual updates until the updater rework
; (tracked on WI-3172) — the host still minisigns the installer (.sig).

#ifndef AppId
  #error Pass /DAppId=com.papercusp.gui|com.papercusp.server
#endif
#ifndef AppName
  #error Pass /DAppName="Papercusp GUI"|"Papercusp Server"
#endif
#ifndef AppVersion
  #error Pass /DAppVersion=<tauri.conf.json version>
#endif
#ifndef BuildRoot
  #error Pass /DBuildRoot=<abs path to src-tauri>
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Papercusp
AppPublisherURL=https://papercuspai.com
DefaultDirName={localappdata}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename={#AppName}_{#AppVersion}_x64-setup
; Per-file compression (SolidCompression=no): the seed (encrypted corestore +
; git bundles) and the WSL rootfs tar.gz are incompressible — stored raw
; (fast compile, ~0 size cost). The sidecar (node, embedded PG, SPA)
; compresses ~3:1 under lzma2.
;
; P-012 (desktop-build-speed): the ISCC pack is the slowest leg of a Windows cut
; (~40 min), and every default cut now runs it TWICE — one pack per role (GUI +
; Server) since WI-5600 restored gui+server as the Windows default. This is an
; ALPHA: installer download size does not matter, build latency does. So use the
; FAST lzma2 variant + multi-threaded packing (CompressionThreads=auto = one per
; core). Trades a larger installer for a much faster pack; the GUI stays under
; Inno's ~4 GB single-file ceiling (the Server already DiskSpans regardless).
; (Before/after wall-clock is MEASURED on the next real VM cut — this box has no
; ISCC; the directives themselves are standard Inno 6 and reversible.)
Compression=lzma2/fast
SolidCompression=no
LZMAUseSeparateProcess=yes
CompressionThreads=auto
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; All-5-buttons source bundle (WI-3306/WI-3308): when stage-source-tree.sh has
; staged the runnable dev/local source tree (sidecar\source.tar.zst, ~2.2 GB
; zstd, PAPERCUSP_STAGE_SOURCE=1 builds), the Server payload exceeds Inno's
; ~4 GB single-exe max — span it: a small setup.exe + setup-*.bin slices.
; Installing then needs the .bin files NEXT TO the exe (build-windows-on-vm.sh
; collects every file from the output dir, so they travel together). Detected
; at compile time from the staged file itself — no new /D define to plumb.
; SINGLE-FILE OVERRIDE (owner-directed 2026-07-08): pass ISCC /DSingleFile
; (build-windows-on-vm.sh does so when PAPERCUSP_SINGLE_FILE=1) to FORCE one
; setup.exe even with the 2.2 GB source tree present — better UX than
; setup.exe + .bin slices, for hosting OFF GitHub (whose release assets cap at
; 2 GiB). Default (no define) stays spanned so the standard GitHub flow works.
#if !Defined(SingleFile) && AppId == "com.papercusp.server" && FileExists(AddBackslash(BuildRoot) + "sidecar\source.tar.zst")
DiskSpanning=yes
DiskSliceSize=2100000000
#endif
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\papercusp-desktop.exe
UninstallDisplayName={#AppName}
SetupIconFile={#BuildRoot}\icons\icon.ico
WizardStyle=modern

[Files]
; ignoreversion (EI/WI-3285, found live 2026-07-07): papercusp-desktop.exe carries
; PE version info, and Inno's default [Files] behavior SKIPS copying a versioned
; file when the destination's embedded version is >= the source's — a "don't
; downgrade a shared DLL" safety feature. AppVersion (tauri.conf.json) does not
; bump on every iteration build, so two consecutive installs at the same "0.0.2"
; silently left the OLD exe in place while sidecar/*, resources/*, seed/* (no PE
; version info, always overwritten) updated fine. Symptom: a fresh install/rebuild
; behaves like the code never changed (stale WSLENV list, stale env-operator
; provisioning, etc.) with zero installer error — Setup reports success either way.
; `ignoreversion` makes the exe follow the same unconditional-overwrite semantics
; as every other file in this installer.
Source: "{#BuildRoot}\target\release\papercusp-desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
#if AppId == "com.papercusp.gui"
; D-004 / P-007: fail-closed thin GUI. The shell carries the shared bootstrap
; SPA and no Server/runtime sibling. Do not widen this to sidecar\* or resources\*.
Source: "{#BuildRoot}\sidecar\spa\*"; DestDir: "{app}\sidecar\spa"; Flags: recursesubdirs createallsubdirs
#endif
#if AppId == "com.papercusp.server"
; The Server owns the full operator/runtime closure, Windows WSL runtime, seed,
; environment sidecars and optional dev-source archive.
; WI-10003665: PrepareToInstall helpers (never installed). Listed FIRST so
; ExtractTemporaryFile reads them from the first disk slice.
Source: "stop-wsl-payload-holders.ps1"; Flags: dontcopy
Source: "stop-wsl-payload-holders.sh"; Flags: dontcopy
; EI-22656004539777797: the Windows launcher requires this content identity
; before staging the runtime into WSL. Name it explicitly: wildcard enumeration
; under the Wine producer can omit dotfiles while still packing serve.mjs.
; No skipifsourcedoesntexist: a missing runtime stamp must fail compilation.
Source: "{#BuildRoot}\sidecar\.sidecar-build-stamp"; DestDir: "{app}\sidecar"; Flags: ignoreversion
Source: "{#BuildRoot}\sidecar\*"; DestDir: "{app}\sidecar"; Excludes: "source.tar.zst,.sidecar-build-stamp,.sidecar-runtime-generation"; Flags: recursesubdirs createallsubdirs
Source: "{#BuildRoot}\resources\*"; DestDir: "{app}\resources"; Flags: recursesubdirs createallsubdirs nocompression
Source: "{#BuildRoot}\seed\*"; DestDir: "{app}\seed"; Flags: recursesubdirs createallsubdirs nocompression
; Bundled env sidecars (WI-3285; pinned contract, plan
; env-switcher-packaged-all-platforms-2026-07-06): the packaged env switcher
; spawns <sidecarDir>\env-sidecars\<envId>\serve.mjs for the non-primary env
; buttons (V1 ships exactly one: staging; prod falls back to the primary's own
; serve.mjs in the launcher). Server-bundle-only — the GUI never runs an
; operator. Staged by build-windows-on-vm.sh OUTSIDE sidecar\ in the build tree
; (sidecar\ is atomically REPLACED by every sidecar publish, which would wipe
; anything staged inside it) and mapped under {app}\sidecar here so runtime
; discovery (dirname(PAPERCUSP_SIDECAR_BIN)/env-sidecars) finds it.
Source: "{#BuildRoot}\env-sidecars\*"; DestDir: "{app}\sidecar\env-sidecars"; Flags: recursesubdirs createallsubdirs
; Runnable dev/local source tree (WI-3306/WI-3308, all-5-buttons dogfood
; bundle): ONE zstd archive; serve extracts it on first boot to the distro's
; ext4 (dev-source-extract.ts) and the env-operator launcher runs the
; dev(:3270)/local(:3055) buttons from that tree. Server-only (the GUI runs no
; operator) + stored raw (zstd is incompressible under lzma2 — same treatment
; as seed/resources). Absent on a build without PAPERCUSP_STAGE_SOURCE=1 →
; entry skipped, dev/local stay 'no-source-tree' exactly as before.
Source: "{#BuildRoot}\sidecar\source.tar.zst"; DestDir: "{app}\sidecar"; Flags: nocompression skipifsourcedoesntexist
; WI-10003673: the hot-runtime generation, precomputed by build-windows-cross.sh
; (bin/lib/sidecar-runtime-generation.js) and bound to the stamp above, so the
; launcher does not hash ~5 GB on every boot. KEEP THIS THE LAST Server entry:
; files are written in [Files] order, so a launch racing an in-progress install
; finds no record (and walks) instead of a record describing files not yet
; written. No skipifsourcedoesntexist: a Server without it must not compile.
Source: "{#BuildRoot}\.sidecar-runtime-generation"; DestDir: "{app}\sidecar"; Flags: ignoreversion
#endif

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\papercusp-desktop.exe"
; Parity with windows/hooks.nsh NSIS_HOOK_POSTINSTALL (WI-2197): the guided
; tutorial shortcut targets wsl.exe directly (needs the app run once so the
; papercup-runtime distro is registered — same precondition as NSIS-era).
; Inno removes it on uninstall automatically (no PREUNINSTALL hook needed).
Name: "{autoprograms}\Papercusp Tutorial & Setup"; Filename: "{sys}\wsl.exe"; Parameters: "-d papercup-runtime --cd ~ -- bash -l -c ""papercusp tutorial"""; IconFilename: "{app}\papercusp-desktop.exe"; Comment: "Open the guided Papercusp tutorial and setup"

; Auto-update relaunch (desktop-auto-update-operational-2026-07-09): tauri-plugin-
; updater types every .exe as NSIS and always passes /UPDATE on its command line.
; Inno ignores unknown switches, but we can READ the raw tail — so when this
; installer was launched BY the updater (silently, via the app's
; installerArgs /VERYSILENT in tauri.conf.json > plugins.updater.windows),
; relaunch the app at the end of the install. A manual first-install (no
; /UPDATE on the tail) is unaffected.
[Run]
Filename: "{app}\papercusp-desktop.exe"; Flags: nowait; Check: IsUpdaterLaunch

[UninstallDelete]
; Inno normally removes {app} with its payload. Keep the role root cleanup
; explicit as a recurrence guard for hosts that leave an empty role directory
; behind. The dirifempty type is intentionally narrow: it cannot remove user
; config nested under a non-empty directory or the shared %LOCALAPPDATA% parent.
Type: dirifempty; Name: "{app}"

[Code]
const
  LegacyUninstallRoot =
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\';
  { auto-launch (via tauri-plugin-autostart) writes login auto-start HERE. }
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  StartupApprovedRunKey =
    'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run';
  SharedWslDistro = 'papercup-runtime';

var
  PayloadUpgradeStarted: Boolean;
  PayloadUpgradeCommitted: Boolean;

function UninstallTargetExists(const UninstallString: String): Boolean;
var
  Target: String;
  Candidate: String;
  QuotePos: Integer;
  I: Integer;
begin
  Result := False;
  Target := Trim(UninstallString);
  if Target = '' then
    Exit;

  { UninstallString is normally a quoted path followed by arguments. }
  if Copy(Target, 1, 1) = '"' then
  begin
    Delete(Target, 1, 1);
    QuotePos := Pos('"', Target);
    if QuotePos > 0 then
      Delete(Target, QuotePos, Length(Target) - QuotePos + 1)
    else
      Target := '';
    Result := (Target <> '') and FileExists(Target);
    Exit;
  end;

  { Unquoted: the executable path may ITSELF contain spaces. Every real
    Papercusp path does ("Papercusp GUI", "Papercusp Server"), and the
    NSIS-era scheme these legacy keys come from writes UninstallString
    unquoted — so truncating at the first space judges a LIVE uninstaller
    missing and deletes a real install's entry, stranding an install that can
    then never be removed. That is precisely the harm this guard exists to
    prevent (EI-19481728463683227), so FAIL SAFE: the target counts as
    present if the whole string, or ANY space-delimited prefix of it, is an
    existing file; only when none of them exists is the entry a genuine
    ghost. FileExists is False for directories, so a prefix that merely names
    a folder never rescues a real ghost. }
  if FileExists(Target) then
  begin
    Result := True;
    Exit;
  end;
  for I := 1 to Length(Target) do
  begin
    if Target[I] = ' ' then
    begin
      Candidate := Copy(Target, 1, I - 1);
      if (Candidate <> '') and FileExists(Candidate) then
      begin
        Result := True;
        Exit;
      end;
    end;
  end;
end;

procedure ReapLegacyUninstallEntry(const LegacyName: String);
var
  LegacyKey: String;
  UninstallString: String;
begin
  LegacyKey := LegacyUninstallRoot + LegacyName;
  { Only remove an old bare-name key when it has an uninstall command and
    that command's executable is genuinely gone. A live entry from another
    install must never be deleted just because its display name is old. }
  if RegKeyExists(HKCU, LegacyKey) and
     RegQueryStringValue(HKCU, LegacyKey, 'UninstallString', UninstallString) and
     (not UninstallTargetExists(UninstallString)) then
    RegDeleteKeyIncludingSubkeys(HKCU, LegacyKey);
end;

procedure ReapLegacyUninstallEntries;
begin
  ReapLegacyUninstallEntry('Papercusp GUI');
  ReapLegacyUninstallEntry('Papercusp Server');
end;

{ Close the role being replaced before Inno starts copying files. Restart
  Manager (the normal CloseApplications=yes path) cannot close a GUI that is
  running in the interactive console session when the installer was launched
  from another session, such as the updater or an SSH-driven silent install.
  With /SUPPRESSMSGBOXES that cross-session failure is auto-answered Abort,
  which rolls back the whole install with exit code 5 after minutes of work.

  Both Papercusp roles intentionally use the same executable basename, so an
  image-name taskkill is unsafe: it would terminate the sibling role too. Use
  the absolute executable path reported by Win32_Process instead, and fail
  before file copy with a stable actionable message if process inspection or
  termination does not succeed. Windows PowerShell 5.1 is part of the target
  Windows image; Get-CimInstance is used because wmic is absent on current
  Windows 11 guests. }
function CloseRoleScopedRunningApplication: String;
var
  TargetPath: String;
  EscapedTargetPath: String;
  PowerShell: String;
  CommandLine: String;
  ResultCode: Integer;
begin
  Result := '';
  TargetPath := ExpandConstant('{app}\papercusp-desktop.exe');
  { Fresh installs and the wine/ISCC harness have no prior role binary, so
    there is nothing to close and no process inspection is needed. }
  if not FileExists(TargetPath) then
    Exit;
  EscapedTargetPath := TargetPath;
  StringChangeEx(EscapedTargetPath, '''', '''''', True);
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  CommandLine :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '$ErrorActionPreference = ''Stop''; ' +
    '$target = ''' + EscapedTargetPath + '''; ' +
    '$procs = @(Get-CimInstance Win32_Process -ErrorAction Stop | ' +
      'Where-Object { $_.Name -eq ''papercusp-desktop.exe'' -and ' +
      '$_.ExecutablePath -eq $target }); ' +
    'foreach ($p in $procs) { Stop-Process -Id ([int]$p.ProcessId) ' +
      '-Force -ErrorAction Stop }; ' +
    '$deadline = (Get-Date).AddSeconds(15); ' +
    'do { $remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | ' +
      'Where-Object { $_.Name -eq ''papercusp-desktop.exe'' -and ' +
      '$_.ExecutablePath -eq $target }); ' +
      'if ($remaining.Count -eq 0) { exit 0 }; ' +
      'Start-Sleep -Milliseconds 200 ' +
    '} while ((Get-Date) -lt $deadline); ' +
    'Write-Error (''role process did not exit: '' + $target); exit 73"';

  Log(Format('windows-role-close: checking %s', [TargetPath]));
  if not Exec(PowerShell, CommandLine, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := Format('windows-role-close-failed: could not start PowerShell to close %s before replacement (Win32 error). Close the app in its interactive session and retry.', ['{#AppName}']);
    Log(Result);
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    Result := Format('windows-role-close-failed: could not close the running %s at %s (PowerShell exit code %d). Close that role in its interactive session and retry.', ['{#AppName}', TargetPath, ResultCode]);
    Log(Result);
  end;
end;

#if AppId == "com.papercusp.server"
function WslDistroRegistered(const Name: String): Boolean;
var
  Keys: TArrayOfString;
  Value: String;
  I: Integer;
begin
  Result := False;
  if not RegGetSubkeyNames(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Lxss', Keys) then
    Exit;
  for I := 0 to GetArrayLength(Keys) - 1 do
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Lxss\' + Keys[I],
         'DistributionName', Value) and (CompareText(Value, Name) = 0) then
    begin
      Result := True;
      Exit;
    end;
end;
#endif

{ WI-10003665: CloseRoleScopedRunningApplication stops the role's Windows exe,
  but the Server's operator runs INSIDE the WSL distro as a detached daemon and
  keeps DrvFs handles into the install dir (measured: node serve.mjs held
  sidecar\source.tar.zst open). Windows refuses to rename a directory holding
  an open file, so BeginPayloadUpgrade failed ("cannot retain ...\sidecar"),
  the install exited 7 and the old version stayed installed. Stop exactly the
  distro processes that hold a handle under our payload roots (SIGTERM first:
  serve's handler stops embedded PG cleanly), via the dontcopy helpers.
  Best effort by design: a failure is logged and returned, and the rename in
  BeginPayloadUpgrade stays the arbiter. The GUI never runs a WSL operator. }
function StopWslPayloadHolders: String;
#if AppId == "com.papercusp.server"
var
  PowerShell, Params, LogPath: String;
  Output: AnsiString;
  ResultCode: Integer;
#endif
begin
  Result := '';
#if AppId == "com.papercusp.server"
  if not DirExists(ExpandConstant('{app}')) then
    Exit;
  if not WslDistroRegistered(SharedWslDistro) then
  begin
    Log('windows-wsl-payload-stop: distro ' + SharedWslDistro + ' is not registered; skip');
    Exit;
  end;
  ExtractTemporaryFile('stop-wsl-payload-holders.ps1');
  ExtractTemporaryFile('stop-wsl-payload-holders.sh');
  LogPath := ExpandConstant('{tmp}\stop-wsl-payload-holders.log');
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\stop-wsl-payload-holders.ps1') + '" -AppDir "' +
    ExpandConstant('{app}') + '" -ScriptDir "' + ExpandConstant('{tmp}') +
    '" -LogPath "' + LogPath + '" -Distro ' + SharedWslDistro;
  Log('windows-wsl-payload-stop: stopping WSL processes that hold ' + ExpandConstant('{app}'));
  if not Exec(PowerShell, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'could not start PowerShell'
  else if ResultCode <> 0 then
    Result := Format('stop helper exit code %d', [ResultCode]);
  if LoadStringFromFile(LogPath, Output) then
    Log('windows-wsl-payload-stop: ' + String(Output));
  if Result <> '' then
    Log('windows-wsl-payload-stop-failed: ' + Result);
#endif
end;

{ D021 / EI-22789249437927838: Files entries overlay, rather than mirror, a
  destination directory. Retire ONLY our three payload roots before copying.
  Never delete the old tree: it may contain locally-added files. Retain it
  outside the active payload and restore it if installation fails.

  A fixed pending directory is also the crash journal. Each root has an intent
  marker written BEFORE its rename, so a retry can distinguish an untouched
  original directory from newly-copied files. Success archives the journal;
  failure restores it. No path from journal contents is ever executed. }
function PayloadRootName(Index: Integer): String;
begin
  case Index of
    0: Result := 'sidecar';
    1: Result := 'resources';
    2: Result := 'seed';
  end;
end;

function PayloadRollbackDir: String;
begin
  Result := ExpandConstant('{app}\.papercusp-payload-rollback');
end;

function NewPayloadBackupDir: String;
var
  Base: String;
  Index: Integer;
begin
  Base := ExpandConstant('{app}\.papercusp-upgrade-backups\') +
    GetDateTimeString('yyyymmddhhnnss', '-', ':');
  Index := 0;
  Result := Base;
  while DirExists(Result) or FileExists(Result) do
  begin
    Index := Index + 1;
    Result := Base + '-' + IntToStr(Index);
  end;
end;

function RestorePayloadUpgrade: String;
var
  Pending, Archive, Name, Current, Previous, Present, Absent: String;
  Index: Integer;
begin
  Result := '';
  Pending := PayloadRollbackDir;
  if not DirExists(Pending) then
    Exit;
  Archive := NewPayloadBackupDir;
  for Index := 0 to 2 do
  begin
    Name := PayloadRootName(Index);
    Current := ExpandConstant('{app}\') + Name;
    Previous := Pending + '\' + Name;
    Present := Pending + '\' + Name + '.present';
    Absent := Pending + '\' + Name + '.absent';
    { Previous present proves the original rename finished. If the intent
      marker exists but Previous does not, Current is the untouched original
      (or it has already been restored by an interrupted recovery). }
    if DirExists(Previous) or FileExists(Absent) then
    begin
      if DirExists(Current) or FileExists(Current) then
      begin
        if (not ForceDirectories(Archive + '\incomplete')) or
          (not RenameFile(Current, Archive + '\incomplete\' + Name)) then
        begin
          Result := 'windows-payload-rollback-failed: cannot preserve incomplete ' + Current;
          Exit;
        end;
      end;
      if DirExists(Previous) and (not RenameFile(Previous, Current)) then
      begin
        Result := 'windows-payload-rollback-failed: cannot restore ' + Current;
        Exit;
      end;
    end;
    if FileExists(Present) and (not DeleteFile(Present)) then
    begin
      Result := 'windows-payload-rollback-failed: cannot clear ' + Present;
      Exit;
    end;
    if FileExists(Absent) and (not DeleteFile(Absent)) then
    begin
      Result := 'windows-payload-rollback-failed: cannot clear ' + Absent;
      Exit;
    end;
  end;
  if not RemoveDir(Pending) then
    Result := 'windows-payload-rollback-failed: pending directory is not empty: ' + Pending;
  Log('windows-payload-rollback: ' + Result);
end;

function BeginPayloadUpgrade: String;
var
  Pending, Name, Current, Marker: String;
  Index: Integer;
begin
  Result := '';
  { Let Inno create a genuinely new app root itself so it records directory
    ownership for uninstall. Creating it early via ForceDirectories would
    leave an otherwise empty root after uninstall. There is no old payload
    and no crash journal to preserve when that directory does not exist. }
  if not DirExists(ExpandConstant('{app}')) then
  begin
    PayloadUpgradeCommitted := True;
    Exit;
  end;
  PayloadUpgradeStarted := True;
  Result := RestorePayloadUpgrade;
  if Result <> '' then
    Exit;
  Pending := PayloadRollbackDir;
  if not ForceDirectories(Pending) then
  begin
    Result := 'windows-payload-prepare-failed: cannot create ' + Pending;
    Exit;
  end;
  for Index := 0 to 2 do
  begin
    Name := PayloadRootName(Index);
    Current := ExpandConstant('{app}\') + Name;
    if FileExists(Current) then
    begin
      Result := 'windows-payload-prepare-failed: expected directory at ' + Current;
      Exit;
    end;
    if DirExists(Current) then
      Marker := Pending + '\' + Name + '.present'
    else
      Marker := Pending + '\' + Name + '.absent';
    if not SaveStringToFile(Marker, '', False) then
    begin
      Result := 'windows-payload-prepare-failed: cannot record ' + Marker;
      Exit;
    end;
    if DirExists(Current) and (not RenameFile(Current, Pending + '\' + Name)) then
    begin
      Result := 'windows-payload-prepare-failed: cannot retain ' + Current;
      Exit;
    end;
  end;
  Log('windows-payload-prepare: retained old payload at ' + Pending);
end;

procedure CommitPayloadUpgrade;
var
  Backup, Pending, Name: String;
  Index: Integer;
  HasPrevious: Boolean;
begin
  Pending := PayloadRollbackDir;
  HasPrevious := False;
  for Index := 0 to 2 do
    if DirExists(Pending + '\' + PayloadRootName(Index)) then
      HasPrevious := True;
  { Fresh installs have no prior payload to preserve. Remove only our own
    empty journal markers so an ordinary uninstall can still remove an empty
    role root. Never recursively remove an unknown or locally-added entry. }
  if not HasPrevious then
  begin
    for Index := 0 to 2 do
    begin
      Name := Pending + '\' + PayloadRootName(Index);
      DeleteFile(Name + '.present');
      DeleteFile(Name + '.absent');
    end;
    if not RemoveDir(Pending) then
      RaiseException('windows-payload-commit-failed: cannot clear empty journal ' + Pending);
    Exit;
  end;
  Backup := NewPayloadBackupDir;
  if (not ForceDirectories(ExtractFileDir(Backup))) or
    (not RenameFile(Pending, Backup)) then
    RaiseException('windows-payload-commit-failed: cannot retain prior payload at ' + Backup);
  Log('windows-payload-commit: prior payload retained at ' + Backup);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  WslStopFailure: String;
begin
  Result := CloseRoleScopedRunningApplication;
  if Result = '' then
  begin
    WslStopFailure := StopWslPayloadHolders;
    Result := BeginPayloadUpgrade;
    if (Result <> '') and (WslStopFailure <> '') then
      Result := Result + ' (stopping the WSL processes that hold it also failed: ' +
        WslStopFailure + '. Quit {#AppName}, or run "wsl --terminate ' + SharedWslDistro +
        '", then retry.)';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    ReapLegacyUninstallEntries;
    if PayloadUpgradeStarted then
    begin
      { Script exceptions in most Inno callbacks are reported and swallowed.
        An exception alone is NOT a failing installer exit code. Keep the
        journal recoverable, suppress updater relaunch, and return an explicit
        failure from GetCustomSetupExitCode if the commit cannot finish. }
      try
        CommitPayloadUpgrade;
        PayloadUpgradeCommitted := True;
      except
        Log('windows-payload-commit-failed: ' + GetExceptionMessage);
      end;
    end;
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if PayloadUpgradeStarted and (not PayloadUpgradeCommitted) then
    Result := 74;
end;

procedure DeinitializeSetup;
var
  Error: String;
begin
  { Deinitialize also runs when the wizard is cancelled before PrepareToInstall.
    Do not touch a previous crash journal until the role close guard has run. }
  if PayloadUpgradeStarted then
  begin
    Error := RestorePayloadUpgrade;
    if Error <> '' then
      Log(Error);
  end;
end;

function IsUpdaterLaunch(): Boolean;
begin
  Result := PayloadUpgradeCommitted and (Pos('/UPDATE', UpperCase(GetCmdTail())) > 0);
end;

{ ── Uninstall cleanup (WI-39403) ──────────────────────────────────────────
  Measured on a real 0.0.17 Windows guest: the uninstaller reports exit 0 and
  removes the install directory entirely, but leaves live login-autostart state
  behind and never touches the multi-GB WSL runtime. Both are fixed below.

  NOTE FOR EDITORS: a Pascal comment ends at the FIRST closing brace, so an Inno
  constant written inline here (the app dir, the AppName define) would terminate
  the comment early and turn the prose into code. Name them in words instead —
  this exact mistake is what the compile leg of
  bin/lib/inno-uninstall-cleanup.selftest.sh caught on the first run. }

{ THE APP registers login auto-start at RUNTIME — tauri-plugin-autostart 2.5.1
  -> auto-launch 0.5.0, whose windows.rs writes an HKCU **Run VALUE** (not a
  Startup-folder shortcut). Inno has no record of a value it never created, so
  it cannot clean it up implicitly: after an otherwise-clean uninstall that Run
  value survives pointing at the executable we just deleted, and EVERY
  SUBSEQUENT LOGIN tries to launch a missing exe.

  The value NAME is auto-launch's app_name = PackageInfo.name, which
  tauri-codegen fills from tauri.conf.json productName (context.rs:268-269) and
  which nothing overrides at the init site (main.rs passes None). That is
  exactly the AppName define. So this is ROLE-SCOPED by construction: uninstalling
  "Papercusp GUI" can never disable "Papercusp Server"'s auto-start. Do not
  "simplify" this to the shared binary name papercusp-desktop — that WOULD
  cross the roles. }
procedure RemoveLoginAutostart;
begin
  RegDeleteValue(HKCU, RunKey, '{#AppName}');
  { auto-launch also writes the enabled/disabled marker Task Manager reads;
    leaving it orphans a Startup-apps row for a program that is gone. }
  RegDeleteValue(HKCU, StartupApprovedRunKey, '{#AppName}');
end;

{ BELT AND BRACES, NOT AN ADMISSION. A Startup-folder shortcut named after the
  product was OBSERVED surviving an uninstall on a 0.0.17 guest. No Papercusp
  code creates one — not this script's [Icons] (both entries are Start Menu
  entries), not windows/hooks.nsh, not the app — so its origin is
  genuinely undetermined and is NOT the autostart mechanism above. Deleting a
  shortcut that bears our product name costs nothing when it is absent, and
  leaving a dangling one is a bad enough end-state to sweep for anyway. }
procedure RemoveStartupShortcut;
begin
  DeleteFile(ExpandConstant('{userstartup}\{#AppName}.lnk'));
end;

{ The OTHER product's Inno uninstall key ('' when AppId is neither role, e.g. a
  nightly — in which case the caller fails safe and keeps the distro). }
function OtherRoleAppId: String;
begin
  if CompareText('{#AppId}', 'com.papercusp.gui') = 0 then
    Result := 'com.papercusp.server'
  else if CompareText('{#AppId}', 'com.papercusp.server') = 0 then
    Result := 'com.papercusp.gui'
  else
    Result := '';
end;

{ The papercup-runtime distro is SHARED by the GUI and the Server. Removing it
  while the other product is still installed would break that install, so the
  offer is only ever made when this is the last Papercusp product on the box.
  Unknown AppId => assume still needed. }
function SharedRuntimeStillNeeded: Boolean;
var
  Other: String;
begin
  Other := OtherRoleAppId;
  if Other = '' then
  begin
    Result := True;
    Exit;
  end;
  Result := RegKeyExists(HKCU, LegacyUninstallRoot + Other + '_is1');
end;

{ RemoveDir is deliberately the only operation used for the install root. It
  succeeds only for an empty directory, so an unexpected payload/config file
  makes this a no-op instead of widening the uninstall into user data. The
  helper is parameterized so the selftest can prove that invariant directly. }
function RemoveEmptyDirectory(const Directory: String): Boolean;
begin
  if not DirExists(Directory) then
  begin
    Result := True;
    Exit;
  end;
  Result := RemoveDir(Directory);
end;

procedure RemoveEmptyInstallDirectory;
var
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  if not RemoveEmptyDirectory(AppDir) then
    Log(Format('windows-uninstall-cleanup: install directory is not empty or could not be removed: %s', [AppDir]));
end;

{ DEFECT 2: after uninstall, `wsl --list` still shows papercup-runtime — the
  imported runtime tarball plus its embedded-PostgreSQL data directory. Multiple
  GB, invisible in Add/Remove Programs, and a normal user has no reason to know
  it exists or that `wsl --unregister` is what removes it.

  OPT-IN, NEVER SILENT, AND NEVER DEFAULT-YES. That distro holds the user's own
  workspace and database: destroying it is irreversible and is not something an
  uninstall may decide on their behalf. A /VERYSILENT run (which is also what
  the auto-updater drives) therefore skips this entirely and keeps the data —
  the strictly safe direction. }
procedure MaybeUnregisterSharedRuntime;
var
  ResultCode: Integer;
begin
  if UninstallSilent then
    Exit;
  if SharedRuntimeStillNeeded then
    Exit;
  if MsgBox('Papercusp also installed a Windows Subsystem for Linux runtime'
            + ' called "' + SharedWslDistro + '".' #13#10#13#10
            + 'It holds your Papercusp workspace and database — often several'
            + ' gigabytes — and it is NOT removed by this uninstall.' #13#10#13#10
            + 'Remove it now and permanently delete that data?' #13#10#13#10
            + 'Choose No to keep it. You can remove it later by running:'
            + #13#10 + '    wsl --unregister ' + SharedWslDistro,
            mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    Exec(ExpandConstant('{sys}\wsl.exe'), '--unregister ' + SharedWslDistro, '',
         SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ NOT cleaned up, deliberately: %LOCALAPPDATA%\Papercusp and %USERPROFILE%\
  .papercusp survive. They are user configuration, and preserving them across
  uninstall/reinstall is the conventional and recoverable choice — unlike a
  dangling autostart entry, which is pure breakage. }
var
  UninstallCleanupDone: Boolean;

procedure PerformUninstallCleanup;
begin
  { Idempotent: the handler below deliberately calls this from two steps. }
  if UninstallCleanupDone then
    Exit;
  UninstallCleanupDone := True;
  RemoveLoginAutostart;
  RemoveStartupShortcut;
  MaybeUnregisterSharedRuntime;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { WHY usUninstall AND NOT ONLY usPostUninstall — this is measured, not
    stylistic. usPostUninstall is the semantically obvious hook and it is the
    one this originally used, but on the Inno/wine toolchain the build and the
    selftest run on it NEVER FIRES: a probe whose handler called Inno's own
    Log() on every step recorded step=0 (usAppMutexCheck) and step=1
    (usUninstall) and nothing else, and the uninstall log ends mid-teardown
    right after "Need to restart Windows?". Cleanup hung off usPostUninstall
    alone therefore silently never ran — the uninstaller still exits 0, which
    is exactly how the original defect stayed invisible.

    So: do the work at usUninstall, where it is proven to happen, and call
    again at usPostUninstall for hosts where that step does run. The second
    call is a no-op via UninstallCleanupDone, which also keeps the WSL prompt
    from being shown twice. Everything here is an idempotent delete, so the
    doubled entry point costs nothing. }
  if (CurUninstallStep = usUninstall) or (CurUninstallStep = usPostUninstall) then
  begin
    PerformUninstallCleanup;
    { usUninstall is the proven callback on the wine/ISCC toolchain; on hosts
      that invoke usPostUninstall after file teardown this removes a leftover
      empty root. The [UninstallDelete] dirifempty entry covers the same
      narrow invariant in Inno's own teardown path. }
    RemoveEmptyInstallDirectory;
  end;
end;
