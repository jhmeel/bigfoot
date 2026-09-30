; Bigfoot installer additions (electron-builder NSIS include).

; Stop Bigfoot's own helper processes so their files aren't locked. Matched by path, so an
; unrelated llama-server the user runs elsewhere is never touched.
!macro stopBigfootHelpers
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-Process input-helper,llama-server,whisper-server -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*\Bigfoot\*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro preInit
  !insertmacro stopBigfootHelpers
!macroend

!macro customUnInit
  !insertmacro stopBigfootHelpers
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; "Open Bigfoot when I sign in" would otherwise point at a missing app.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.bigfoot.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.bigfoot.app"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Bigfoot settings and the downloaded AI model?$\r$\n$\r$\nThe model can take several gigabytes. Keep it if you plan to install Bigfoot again, so you don't have to download it twice." /SD IDNO IDNO bigfoot_keep_data
      RMDir /r "$APPDATA\Bigfoot"
    bigfoot_keep_data:
  ${endIf}
!macroend
