; Extra uninstaller step: before the files are removed, let the app point Steam's Play button for
; Happy Wheels back at the normal game (it may have been set to open Multiplayer).
; Skipped on updates, which reinstall over the old version.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hwmp-uninstall'
  ${endIf}
!macroend
