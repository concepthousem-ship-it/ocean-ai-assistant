; Ocean for Windows installer. Installs for the current user only (no admin needed).
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "Ocean"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Ocean"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Ocean ${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Ocean.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Ocean now"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Ocean"
VIAddVersionKey "FileDescription" "Ocean installer"
VIAddVersionKey "CompanyName" "DigiVireo"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Gudani"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ocean"

Section "Install"
  ; Close Ocean if it is running, so its files can be replaced.
  nsExec::Exec 'taskkill /IM Ocean.exe /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC}\*.*"
  File "/oname=$INSTDIR\ocean.ico" "${ICON}"
  WriteUninstaller "$INSTDIR\Uninstall Ocean.exe"
  CreateShortcut "$DESKTOP\Ocean.lnk" "$INSTDIR\Ocean.exe" "" "$INSTDIR\ocean.ico"
  CreateDirectory "$SMPROGRAMS"
  CreateShortcut "$SMPROGRAMS\Ocean.lnk" "$INSTDIR\Ocean.exe" "" "$INSTDIR\ocean.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Ocean"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "DigiVireo"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\ocean.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Ocean.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; After a silent update with --relaunch, open Ocean again.
Function .onInstSuccess
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--relaunch" $R1
  IfErrors done
    Exec '"$INSTDIR\Ocean.exe"'
  done:
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Ocean.exe /F'
  Sleep 800
  Delete "$DESKTOP\Ocean.lnk"
  Delete "$SMPROGRAMS\Ocean.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; Your settings (allowed folders, Ollama model) in %APPDATA%\Ocean are kept.
SectionEnd
