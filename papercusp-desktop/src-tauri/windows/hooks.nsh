; windows-macos-tutorial-shortcut-parity-2026-07-04 (WI-2197): a second
; Start-Menu shortcut, alongside Tauri's own "Papercusp GUI" entry, that opens
; the guided tutorial/setup shell. Parity with the Linux .deb's third
; `.desktop` icon (../deb/postinstall.sh, agent-first-onboarding P-014) and the
; macOS "Papercusp Tutorial.app" wrapper
; (packages/operator-core/lib/desktop-install/papercusp-files.ts,
; writeMacTutorialApp). This is the NSIS-installer leg; see
; fragments/tutorial-shortcut.wxs for the MSI/WiX equivalent + full rationale
; (wsl.exe target, why it needs the app run at least once already, etc).
;
; Referenced from tauri.conf.json via bundle.windows.nsis.installerHooks (see
; https://v2.tauri.app/distribute/windows-installer).

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\Papercusp Tutorial & Setup.lnk" "$SYSDIR\wsl.exe" '-d papercup-runtime --cd ~ -- bash -l -c "papercusp tutorial"' "$INSTDIR\papercusp-desktop.exe" 0 SW_SHOWNORMAL "" "Open the guided Papercusp tutorial and setup"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$SMPROGRAMS\Papercusp Tutorial & Setup.lnk"
!macroend
