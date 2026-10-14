; NSIS installer hooks (wired via tauri.conf.json bundle.windows.nsis.installerHooks).
; Check only this installation's executable. Never terminate processes by image name.
; OPEN_EXISTING probes write access without changing file contents. Missing files are fresh installs.
; Define this function for each NSIS context used by the template. Unlike recursive RMDir,
; it removes directory reparse points themselves without walking their targets.
!macro _WS_DEFINE_REMOVE_TREE prefix
Function ${prefix}WS_RemoveTree
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3'
  IntOp $3 $3 & 0x400
  IntCmp $3 0 ws_tree_walk ws_tree_remove ws_tree_remove
  ws_tree_walk:
  FindFirst $1 $2 "$0\*"
  ws_tree_loop:
  StrCmp $2 "" ws_tree_close
  StrCmp $2 "." ws_tree_next
  StrCmp $2 ".." ws_tree_next
  ; Leave ambiguous NTFS names untouched instead of normalizing them into another path.
  StrCpy $3 $2 1 -1
  StrCmp $3 "." ws_tree_next
  StrCmp $3 " " ws_tree_next
  System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i.r3'
  IntOp $3 $3 & 0x10
  IntCmp $3 0 ws_tree_file
  Push "$0\$2"
  Call ${prefix}WS_RemoveTree
  Goto ws_tree_next
  ws_tree_file:
  Delete "$0\$2"
  ws_tree_next:
  FindNext $1 $2
  Goto ws_tree_loop
  ws_tree_close:
  FindClose $1
  ws_tree_remove:
  RMDir "$0"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend

!macro _WS_REQUIRE_APP_CLOSED executableName
  !define WS_GUARD_ID ${__LINE__}
  Push $0
  Push $1
  ws_guard_retry_${WS_GUARD_ID}:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${executableName}", i 0x40000000, i 7, p 0, i 3, i 128, p 0) p.r0 ?e'
  Pop $1
  StrCmp $0 -1 ws_guard_failed_${WS_GUARD_ID}
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto ws_guard_done_${WS_GUARD_ID}
  ws_guard_failed_${WS_GUARD_ID}:
  StrCmp $1 2 ws_guard_done_${WS_GUARD_ID}
  StrCmp $1 3 ws_guard_done_${WS_GUARD_ID}
  DetailPrint "Cannot change $INSTDIR\${executableName}. Close Widgetsack from this installation first."
  IfSilent ws_guard_abort_${WS_GUARD_ID}
  StrCmp $PassiveMode 1 ws_guard_abort_${WS_GUARD_ID}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Save your Studio changes, then exit Widgetsack from this folder:$\r$\n$INSTDIR$\r$\n$\r$\nSelect Retry to continue. If Widgetsack is already closed, check access to this folder." IDRETRY ws_guard_retry_${WS_GUARD_ID} IDCANCEL ws_guard_abort_${WS_GUARD_ID}
  ws_guard_abort_${WS_GUARD_ID}:
  Pop $1
  Pop $0
  SetErrorLevel 1
  Quit
  ws_guard_done_${WS_GUARD_ID}:
  Pop $1
  Pop $0
  !undef WS_GUARD_ID
!macroend

; Old uninstallers can contain image-name shutdown hooks. Use this installer's guarded
; uninstaller code for replacement, with the original installation directory passed by the caller.
!macro _WS_REPLACEMENT_UNINSTALLER
  InitPluginsDir
  WriteUninstaller "$PLUGINSDIR\widgetsack-upgrade-uninstall.exe"
  StrCpy $R1 '$\"$PLUGINSDIR\widgetsack-upgrade-uninstall.exe$\"'
!macroend

!macro _WS_REMOVE_LEGACY_AGENT prefix
  ; v0.0.62 shipped Node and node_modules beneath this installation resource directory.
  ; Remove only that legacy resource from an existing installation. Keep user settings and agents.
  IfFileExists "$INSTDIR\widgetsack.exe" 0 ws_agent_cleanup_done
  Push "$INSTDIR\studio-agent"
  Call ${prefix}WS_RemoveTree
  IfFileExists "$INSTDIR\studio-agent\*.*" 0 ws_agent_cleanup_done
  DetailPrint "Could not remove the old studio-agent files. Close programs using those files and retry."
  IfSilent ws_agent_cleanup_abort
  StrCmp $PassiveMode 1 ws_agent_cleanup_abort
  MessageBox MB_OK|MB_ICONSTOP "Could not remove the old studio-agent files. Close widgetsack and try the upgrade again." /SD IDOK
  ws_agent_cleanup_abort:
  SetErrorLevel 1
  Quit
  ws_agent_cleanup_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _WS_REQUIRE_APP_CLOSED "${MAINBINARYNAME}.exe"
  !insertmacro _WS_REMOVE_LEGACY_AGENT ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Pre-0.0.28 installers nested the shortcut inside a "widgetsack" Start Menu FOLDER, which
  ; Windows 11's All-apps list and search index handle poorly (the report was "the app doesn't
  ; show up after install"). The shortcut now lands at the Programs root (no startMenuFolder),
  ; so clear the leftover folder an upgrade would otherwise orphan. Runs AFTER the new
  ; shortcuts are created — the root-level widgetsack.lnk is untouched.
  Push "$SMPROGRAMS\widgetsack"
  Call WS_RemoveTree

  ; widgetsack evolved from the "np" (nowplaying-widget) app and kept its bundle identifier
  ; (io.github.gyng). Windows de-dupes Start entries by AppUserModelID, so a leftover np.lnk from the
  ; old app shadows widgetsack's shortcut — Start lists the app as "np" and searching "widgetsack"
  ; finds nothing (the reported "doesn't show up in start"). Remove the legacy np shortcuts and its
  ; autostart entries (the shared identifier would also collide with single-instance). np autostarts
  ; via a Startup-folder shortcut (and possibly a Run key), so clear both. The old np install itself
  ; is left alone — uninstall it via its own entry in Apps & features.
  Delete "$SMPROGRAMS\np.lnk"
  Delete "$DESKTOP\np.lnk"
  Delete "$SMSTARTUP\np.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "np"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _WS_REQUIRE_APP_CLOSED "${MAINBINARYNAME}.exe"
  !insertmacro _WS_REMOVE_LEGACY_AGENT "un."
!macroend
