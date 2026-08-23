' ============================================================================
' dsh-activate.vbs - dsh-notify no-window toast activation entry
'
' When a toast button/body is clicked, Windows starts wscript.exe (GUI subsystem,
' no console window) via the registered dsh-notify:// protocol. This script then
' launches dsh-toast.ps1 -Activate <uri> hidden, so no cmd/PowerShell window flashes.
' ============================================================================
Option Explicit

Dim fso, scriptsDir, ps1, sh, psExe, cmd, uri
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptsDir & "\dsh-toast.ps1"
psExe = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

uri = ""
If WScript.Arguments.Count > 0 Then uri = WScript.Arguments(0)

' Window style 0 = hidden; third param False = do not wait
cmd = """" & psExe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Activate """ & uri & """"
sh.Run cmd, 0, False