; Picked up by electron-builder from buildResources.
;
; The per-user install folder defaults to %LOCALAPPDATA%\Programs\<package
; name>, and the package name must stay "t3code" (see build-desktop-artifact.ts),
; which would install SECode over the official T3 Code. multiUser.nsh uses
; InstallLocation from SECode's own registry key when it is set, so point it at
; a separate folder before that runs.
!macro preInit
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\secode"
!macroend
