; Included by electron-builder's NSIS installer (electron-builder.yml nsis.include).
;
; mtkprof v0.6.0 and older (the Tauri shell) installed per user with an uninstall entry of its own,
; HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\mtkprof (the Electron installer's entry
; is keyed by a GUID, so the two never collide). Left alone, an upgrade would leave two apps, two
; Start menu entries and two claims on .trc. So before installing, run the old uninstaller silently
; and wait for it (_?= keeps it in place, so ExecWait really waits). Silent, it keeps the user's data
; (settings, workspace and cache are shared with this app). Nothing happens without that entry.
; NOT TESTED ON WINDOWS YET (docs/HANDOFF.md).

!include "FileFunc.nsh"

!macro mtkprofUnquote VAR
  StrCpy $R9 ${VAR} 1
  ${If} $R9 == '"'
    StrCpy ${VAR} ${VAR} "" 1
  ${EndIf}
  StrCpy $R9 ${VAR} 1 -1
  ${If} $R9 == '"'
    StrCpy ${VAR} ${VAR} -1
  ${EndIf}
!macroend

!macro customInit
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mtkprof" "UninstallString"
  ${If} $R0 != ""
    !insertmacro mtkprofUnquote $R0
    ${GetParent} $R0 $R1
    ${If} ${FileExists} $R0
      DetailPrint "Removing the previous mtkprof (Tauri) from $R1"
      ExecWait '"$R0" /S _?=$R1' $R2
      ; with _?= the uninstaller cannot delete itself or its folder
      Delete $R0
      RMDir $R1
    ${Else}
      ; a stale entry (the folder is gone): drop it so Apps & features does not list a ghost
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\mtkprof"
    ${EndIf}
  ${EndIf}
!macroend
