# ============================================================================
# dsh-toast.ps1 - dsh-notify Windows native toast bridge
#
# Portable design (all Windows 10 / 11, compatible with security software):
#   * Uses only built-in Windows PowerShell 5.1 (powershell.exe) + .NET Framework
#   * Uses the built-in WinRT API (Windows.UI.Notifications) for ToastNotification
#   * Unpackaged apps need an AppUserModelID (AUMID) to show toasts:
#        - Register DisplayName/IconUri under HKCU\Software\Classes\AppUserModelId\<AUMID>
#        - Does NOT create any .lnk shortcut (avoids antivirus blocking/deletion)
#   * Notification only (title + body): NO buttons, NO protocol activation,
#     NO wscript/VBS, NO click-to-activate. This keeps antivirus software quiet.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#       -File dsh-toast.ps1 -Show  <payload.json>
# ============================================================================
param(
  [string]$Show
)
$ErrorActionPreference = 'Stop'
$Aumid = 'DSH.Notify'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PowerShellExe = (Get-Command powershell.exe).Source
$IconPath = Join-Path (Split-Path -Parent $ScriptDir) 'assets\dsh-notify.ico'
if (-not (Test-Path $IconPath)) { $IconPath = "$PowerShellExe,0" }

# ---------------------------------------------------------------------------
# Registry: AUMID (toast identity) only. No custom protocol, no .lnk.
# ---------------------------------------------------------------------------
function Ensure-Aumid {
  $aumidBase = 'HKCU:\Software\Classes\AppUserModelId\' + $Aumid
  try {
    New-Item -Path $aumidBase -Force | Out-Null
    New-ItemProperty -Path $aumidBase -Name 'DisplayName' -Value 'DSH Notify' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $aumidBase -Name 'IconUri' -Value $IconPath -PropertyType String -Force | Out-Null
  } catch {
    Write-Warning ('dsh-toast: AUMID registration failed: ' + $_.Exception.Message)
  }
}

function Xml-Escape([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '' }
  return [System.Security.SecurityElement]::Escape($Value)
}

# ---------------------------------------------------------------------------
# Show toast (notification only, no actions)
# ---------------------------------------------------------------------------
function Show-NativeToast([string]$PayloadPath) {
  if (-not (Test-Path $PayloadPath)) { throw ('payload not found: ' + $PayloadPath) }
  $p = Get-Content $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Ensure-Aumid

  $title = Xml-Escape ([string]$p.title)
  if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DSH-DeepSeek Harness' }
  $body = Xml-Escape ([string]$p.body)
  $tag = [string]$p.tag
  if ([string]::IsNullOrWhiteSpace($tag)) { $tag = 'dsh-notify' }

  $xml = '<?xml version="1.0" encoding="utf-8"?><toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>'

  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $toast.Tag = $tag
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
  try { $notifier.RemoveGroupAndTagByTag($tag) | Out-Null } catch { }
  $notifier.Show($toast)
}

if ($Show) { Show-NativeToast $Show; exit 0 }
Write-Error 'dsh-toast.ps1: need -Show <payload.json>'
exit 1
