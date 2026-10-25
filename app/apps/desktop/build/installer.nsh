; PRSLOY: unpack PortableGit while installing, so the first launch does not wait ~30 s for it
; before the first «Код» turn. The app uses resources\runtimes\git only when the marker
; exists (src/main/prsloy/runtime-git.ts → isInstallerGit); otherwise it unpacks
; resources\runtimes\archives\git.7z.exe into userData on first launch, as before.
; The tree lives in the install dir: uninstall and updates replace it with the app.

!macro customInstall
  DetailPrint "Unpacking components..."
  RMDir /r "$INSTDIR\resources\runtimes\git"
  nsExec::Exec '"$INSTDIR\resources\runtimes\archives\git.7z.exe" -y "-o$INSTDIR\resources\runtimes\git"'
  Pop $0
  ${If} $0 == 0
  ${AndIf} ${FileExists} "$INSTDIR\resources\runtimes\git\bin\bash.exe"
    FileOpen $1 "$INSTDIR\resources\runtimes\git\.prsloy-installer-git" w
    FileWrite $1 "ok"
    FileClose $1
    ; Not needed once unpacked (the app only falls back to it without the marker).
    Delete "$INSTDIR\resources\runtimes\archives\git.7z.exe"
  ${Else}
    RMDir /r "$INSTDIR\resources\runtimes\git"
  ${EndIf}
!macroend

; #32: «Удалить» and right away «Установить». The uninstaller runs from a %TEMP% copy and returns
; at once; it deletes PRSLOY.exe early, then thousands of PortableGit files, and the registry keys
; last. An installer started in that window finds the old uninstall key, cannot run the
; uninstaller (already deleted) and races the copy that is still deleting the folder. Wait while
; the key says «installed» but its PRSLOY.exe is gone: that is an uninstall in progress. A normal
; update (the exe is there) does not wait; a key left by a broken install stops waiting after 60 s.
!macro customInit
  Push $R8
  Push $R9
  StrCpy $R8 0
  prsloyWaitUninstall:
    ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $R9 "" prsloyUninstallDone
    IfFileExists "$R9\${APP_EXECUTABLE_FILENAME}" prsloyUninstallDone
    IntCmp $R8 120 prsloyUninstallDone
    IntOp $R8 $R8 + 1
    Sleep 500
    Goto prsloyWaitUninstall
  prsloyUninstallDone:
  Pop $R9
  Pop $R8
!macroend
