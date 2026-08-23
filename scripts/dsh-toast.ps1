# ============================================================================
# dsh-toast.ps1 - dsh-notify Windows native toast bridge
#
# Portable design (all Windows 10 / 11, compatible with security software):
#   * Uses only built-in Windows PowerShell 5.1 (powershell.exe) + .NET Framework
#   * Uses the built-in WinRT API (Windows.UI.Notifications) for ToastNotification
#   * Unpackaged apps need an AppUserModelID (AUMID) to show toasts:
#        - Register DisplayName/IconUri under HKCU\Software\Classes\AppUserModelId\<AUMID>
#        - Does NOT create any .lnk shortcut (avoids antivirus blocking/deletion)
#   * Toast button clicks use protocol activation: custom scheme dsh-notify:// is
#     registered under HKCU\Software\Classes\dsh-notify; clicking launches
#     wscript.exe dsh-activate.vbs (GUI subsystem, no console flash) which starts
#     powershell.exe -Activate <uri> hidden; the script calls back to DSH.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#       -File dsh-toast.ps1 -Show  <payload.json>
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#       -File dsh-toast.ps1 -Activate <dsh-notify://activate/TOKEN>
# ============================================================================
param(
  [string]$Show,
  [string]$Activate
)
$ErrorActionPreference = 'Stop'
$Aumid = 'DSH.Notify'
$Scheme = 'dsh-notify'
$ScriptPath = $MyInvocation.MyCommand.Definition
$ScriptDir = Split-Path -Parent $ScriptPath
$PowerShellExe = (Get-Command powershell.exe).Source
$IconPath = Join-Path (Split-Path -Parent $ScriptDir) 'assets\dsh-notify.ico'
if (-not (Test-Path $IconPath)) { $IconPath = "$PowerShellExe,0" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshToastWin32
{
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

# ---------------------------------------------------------------------------
# Registry: AUMID (toast identity) + custom protocol (button activation)
# ---------------------------------------------------------------------------
function Ensure-Registrations {
  # AUMID - registry only, no .lnk
  $aumidBase = 'HKCU:\Software\Classes\AppUserModelId\' + $Aumid
  try {
    New-Item -Path $aumidBase -Force | Out-Null
    New-ItemProperty -Path $aumidBase -Name 'DisplayName' -Value 'DSH Notify' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $aumidBase -Name 'IconUri' -Value $IconPath -PropertyType String -Force | Out-Null
  } catch {
    Write-Warning ('dsh-toast: AUMID registration failed: ' + $_.Exception.Message)
  }

  # Custom protocol dsh-notify://activate/<token>
  # Use wscript.exe (GUI subsystem, no console) + VBS to launch powershell hidden,
  # so clicking a toast button never flashes a cmd/PowerShell window.
  $wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
  $vbsPath = Join-Path $ScriptDir 'dsh-activate.vbs'
  $cmd = '"' + $wscriptExe + '" "' + $vbsPath + '" "%1"'
  try {
    $protoBase = 'HKCU:\Software\Classes\' + $Scheme
    New-Item -Path ($protoBase + '\shell\open\command') -Force | Out-Null
    New-ItemProperty -Path $protoBase -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path ($protoBase + '\shell\open\command') -Name '(default)' -Value $cmd -PropertyType String -Force | Out-Null
  } catch {
    Write-Warning ('dsh-toast: protocol registration failed: ' + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function ConvertFrom-Base64Url([string]$Value) {
  $s = $Value.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

function Xml-Escape([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '' }
  return [System.Security.SecurityElement]::Escape($Value)
}

# ---------------------------------------------------------------------------
# Show toast
# ---------------------------------------------------------------------------
function Show-NativeToast([string]$PayloadPath) {
  if (-not (Test-Path $PayloadPath)) { throw ('payload not found: ' + $PayloadPath) }
  $p = Get-Content $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Ensure-Registrations

  $title = Xml-Escape ([string]$p.title)
  if ([string]::IsNullOrWhiteSpace($title)) { $title = 'DSH-DeepSeek Harness' }
  $body = Xml-Escape ([string]$p.body)
  $tag = [string]$p.tag
  if ([string]::IsNullOrWhiteSpace($tag)) { $tag = 'dsh-notify' }

  # Buttons and toast body clicks all use protocol activation: dsh-notify://activate/<token>
  $launch = ''
  $actions = ''
  $parts = @()
  $hasButtons = $false
  foreach ($btn in $p.buttons) {
    $label = Xml-Escape ([string]$btn.label)
    $arg = Xml-Escape ([string]$btn.token)
    if (-not [string]::IsNullOrWhiteSpace($label) -and -not [string]::IsNullOrWhiteSpace($arg)) {
      $parts += '<action content="' + $label + '" activationType="protocol" arguments="' + $Scheme + '://activate/' + $arg + '"/>'
      $hasButtons = $true
    }
  }
  if ($hasButtons) {
    $actions = '<actions>' + ($parts -join '') + '</actions>'
  }
  $launchToken = [string]$p.launch
  if (-not [string]::IsNullOrWhiteSpace($launchToken)) {
    $launch = ' activationType="protocol" launch="' + $Scheme + '://activate/' + $launchToken + '"'
  }

  $xml = '<?xml version="1.0" encoding="utf-8"?><toast' + $launch + '><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual>' + $actions + '</toast>'

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

# ---------------------------------------------------------------------------
# Activation: toast button / toast body clicked
# ---------------------------------------------------------------------------
function Invoke-Activation([string]$Uri) {
  if ([string]::IsNullOrWhiteSpace($Uri)) { return }
  # URI looks like dsh-notify://activate/D<token>
  $token = $Uri
  $marker = $Scheme + '://activate/'
  if ($token.StartsWith($marker)) { $token = $token.Substring($marker.Length) }
  if ([string]::IsNullOrWhiteSpace($token)) { return }
  # Strip the 'D' prefix added by the server (so a leading '-' in base64url is not
  # mistaken for a parameter switch).
  if ($token.StartsWith('D')) { $token = $token.Substring(1) }

  $json = ''
  try { $json = ConvertFrom-Base64Url $token } catch { return }
  $obj = $null
  try { $obj = $json | ConvertFrom-Json } catch { return }
  $url = [string]$obj.u
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    try {
      $target = $url.TrimEnd('/') + '/dsh-notify/activate'
      $body = @{ token = $token } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri $target -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
    } catch { }
  }
  # Bring the DSH window to the foreground (desktop shell process DshDesktop,
  # otherwise a window whose title contains "DeepSeek Harness").
  try {
    $p = Get-Process DshDesktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) {
      $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
    }
    if ($p) {
      if ([DshToastWin32]::IsIconic($p.MainWindowHandle)) { [DshToastWin32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }
      [DshToastWin32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
  } catch { }
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------
if ($Activate) { Invoke-Activation $Activate; exit 0 }
if ($Show) { Show-NativeToast $Show; exit 0 }
Write-Error 'dsh-toast.ps1: need -Show <payload.json> or -Activate <uri>'
exit 1
