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
