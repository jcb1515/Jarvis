!macro NSIS_HOOK_POSTINSTALL
  ; Desktop builds use bundled assets and must not retain browser PWA caches.
  RMDir /r "$LOCALAPPDATA\com.astrono.jarvis\EBWebView\Default\Service Worker"
  RMDir /r "$LOCALAPPDATA\com.astrono.jarvis\EBWebView\Default\Code Cache"
  CreateDirectory "$SMPROGRAMS\Astrono Jarvis"
  CreateShortCut "$SMPROGRAMS\Astrono Jarvis\Astrono Jarvis.lnk" "$INSTDIR\Astrono Jarvis.exe" "" "$INSTDIR\Astrono Jarvis.exe" 0
  CreateShortCut "$DESKTOP\Astrono Jarvis.lnk" "$INSTDIR\Astrono Jarvis.exe" "" "$INSTDIR\Astrono Jarvis.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\Astrono Jarvis\Astrono Jarvis.lnk"
  RMDir "$SMPROGRAMS\Astrono Jarvis"
  Delete "$DESKTOP\Astrono Jarvis.lnk"
!macroend
