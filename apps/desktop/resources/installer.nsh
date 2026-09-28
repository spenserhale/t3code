!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend

; SECode: keep the per-user install off the official build's folder.
;
; The per-user install folder defaults to %LOCALAPPDATA%\Programs\<package
; name>, and the package name must stay "t3code" (see build-desktop-artifact.ts),
; which would install SECode over the official build. multiUser.nsh uses
; InstallLocation from SECode's own registry key when it is set, so point it at
; a separate folder before that runs.
!macro preInit
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\secode"
!macroend
