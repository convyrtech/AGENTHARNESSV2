# One-click installer proof (CI, windows-latest, clean runner): run the installer like a double
# click (no /S), screenshot the screen every 0.5 s, read every window the installer shows
# (titles and control texts via WM_GETTEXT) and fail on any wizard wording. Then the same for the
# uninstaller. Writes <OutDir>\oneclick.json and <OutDir>\oneclick\*.png.
#
#   pwsh oneclick-install.ps1 -Installer <PRSLOY-…-win-x64.exe> -OutDir <dir> [-Strict]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$Strict
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint ms, out IntPtr r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  const uint WM_GETTEXT = 0x000D;
  const uint BM_CLICK = 0x00F5;
  static string Text(IntPtr h) {
    var sb = new StringBuilder(1024); IntPtr r;
    SendMessageTimeout(h, WM_GETTEXT, (IntPtr)sb.Capacity, sb, 0x0002, 500, out r);
    return sb.ToString();
  }
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  // Visible top-level windows of the given processes and their visible controls, one line each:
  // "pid|top|class|text", "pid|child|class|text", or "pid|msgbtn|Button|text" for the buttons of a
  // plain message box (Windows labels those in the OS language, not the installer's).
  static readonly HashSet<string> MsgBoxButtons = new HashSet<string> {
    "OK", "Cancel", "Yes", "No", "ОК", "Отмена", "Да", "Нет" };
  public static List<string> Read(uint[] pids) {
    var set = new HashSet<uint>(pids); var o = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(h)) return true;
      var kids = new List<KeyValuePair<string, string>>();
      EnumChildWindows(h, (c, l2) => {
        if (IsWindowVisible(c)) kids.Add(new KeyValuePair<string, string>(Cls(c), Text(c)));
        return true;
      }, IntPtr.Zero);
      int buttons = 0; bool onlyMsgButtons = true, progress = false;
      foreach (var k in kids) {
        if (k.Key == "msctls_progress32") progress = true;
        if (k.Key == "Button") { buttons++; if (!MsgBoxButtons.Contains(k.Value.Replace("&", ""))) onlyMsgButtons = false; }
      }
      bool msgBox = Cls(h) == "#32770" && !progress && buttons > 0 && buttons <= 3 && onlyMsgButtons;
      o.Add(pid + "|top|" + Cls(h) + "|" + Text(h));
      foreach (var k in kids) {
        if (k.Value.Length == 0) continue;
        o.Add(pid + "|" + (msgBox && k.Key == "Button" ? "msgbtn" : "child") + "|" + k.Key + "|" + k.Value);
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
  // Press a button (e.g. «Да» in a confirmation box) in a dialog of the given processes.
  public static bool Click(uint[] pids, string label) {
    var set = new HashSet<uint>(pids); bool done = false;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (done || !set.Contains(pid) || !IsWindowVisible(h) || Cls(h) != "#32770") return true;
      EnumChildWindows(h, (c, l2) => {
        if (!done && Cls(c) == "Button" && Text(c).Replace("&", "") == label) {
          SendMessage(c, BM_CLICK, IntPtr.Zero, IntPtr.Zero); done = true;
        }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return done;
  }
}
'@

$shots = Join-Path $OutDir 'oneclick'
New-Item -ItemType Directory -Force $shots | Out-Null
$wizard = 'Next|Install|Choose|Anyone who uses|Back|Browse|Cancel'

function Shot([string]$name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $shots "$name.png"))
    $g.Dispose(); $bmp.Dispose()
  } catch { }
}

# Watch one phase: start the process, poll windows of every process born after $before (installer,
# its re-launched copies, the uninstaller's Au_ copy), screenshot, stop when they are all gone.
function Watch([string]$phase, [scriptblock]$start, [int]$timeoutSec) {
  $before = @{}; Get-Process | ForEach-Object { $before[$_.Id] = $true }
  $t0 = Get-Date
  $proc = & $start
  $texts = [ordered]@{}; $i = 0; $seen = @{}; $confirmed = 0
  do {
    Start-Sleep -Milliseconds 500
    # Installer, its re-launched copies and the uninstaller (Un_A / Au_ in %TEMP%) only: not the
    # app it starts, nor the git/bash/python children of that app.
    $fresh = Get-Process | Where-Object {
      -not $before.ContainsKey($_.Id) -and ($_.Name -like 'PRSLOY-*' -or $_.Name -like 'Un_*' -or $_.Name -like 'Au_*' -or $_.Name -like 'Uninstall*') }
    foreach ($p in $fresh) { $seen[$p.Id] = $p.Name }
    if ($fresh) {
      $ids = [uint32[]]@($fresh | ForEach-Object { $_.Id })
      foreach ($line in [Win]::Read($ids)) { $texts[$line] = $true }
      # A confirmation box would block an unattended run: record it, then answer «Да».
      foreach ($label in 'Да', 'ОК', 'OK') { if ([Win]::Click($ids, $label)) { $confirmed++; break } }
    }
    Shot ('{0}-{1:D3}' -f $phase, $i); $i++
    $alive = if ($seen.Count) { Get-Process -Id @($seen.Keys) -ErrorAction SilentlyContinue } else { $null }
  } while (($alive -or -not $proc.HasExited) -and ((Get-Date) - $t0).TotalSeconds -lt $timeoutSec)
  $seconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Shot "$phase-end"
  return [ordered]@{
    seconds = $seconds
    finishedOnItsOwn = -not $alive
    exitCode = if ($proc.HasExited) { $proc.ExitCode } else { $null }
    processes = @($seen.Values | Sort-Object -Unique)
    windows = @($texts.Keys)
    # NSIS's own branding line («Nullsoft Install System vX») is not a wizard; message-box
    # buttons are labelled by Windows in the OS language.
    wizardWords = @($texts.Keys | Where-Object {
        $f = $_ -split '\|', 4; $f[1] -ne 'msgbtn' -and $f[3] -cmatch $wizard -and $f[3] -notmatch 'Nullsoft' })
    # Every text the installer itself writes must be Russian: English words without Cyrillic
    # (product name and version aside) are leftovers.
    englishTexts = @($texts.Keys | Where-Object {
        $f = $_ -split '\|', 4
        $t = ($f[3] -replace 'PRSLOY', '' -replace '\b\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?', '' -replace 'Nullsoft Install System v[\d.]+', '')
        $f[1] -ne 'msgbtn' -and $t -match '[A-Za-z]{4,}' -and $t -notmatch '[А-Яа-яЁё]' })
    screenshots = $i
    confirmationsAnswered = $confirmed
  }
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\PRSLOY'
$exe = Join-Path $installDir 'PRSLOY.exe'
$appData = Join-Path $env:APPDATA 'PRSLOY'
$report = [ordered]@{ installer = (Split-Path $Installer -Leaf) }

# No UAC: the installer's manifest asks for asInvoker (per-user install).
$fs = [IO.File]::OpenRead($Installer)
$head = New-Object byte[] ([Math]::Min(4MB, $fs.Length)); [void]$fs.Read($head, 0, $head.Length); $fs.Close()
$manifest = [Text.Encoding]::ASCII.GetString($head)
$report.requestedExecutionLevel = ([regex]::Match($manifest, 'requestedExecutionLevel\s+level="(\w+)"')).Groups[1].Value

# ── Install: a double click ──
$report.install = Watch 'install' { Start-Process -FilePath $Installer -PassThru } 300
$appDeadline = (Get-Date).AddSeconds(60)
do { $app = Get-Process PRSLOY -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } } while (-not $app -and (Get-Date) -lt $appDeadline -and -not (Start-Sleep -Milliseconds 500))
$report.appStartedAfterFinish = [bool]$app
$report.installDir = $installDir
$report.installedExe = Test-Path -LiteralPath $exe
$report.perUserUninstallKey = [bool](Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'PRSLOY*')
Start-Sleep -Seconds 8   # let the app write its profile and show its first window
Shot 'install-app'
$report.appDataCreated = Test-Path -LiteralPath $appData
Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# ── Uninstall: also no wizard, Russian, keeps %APPDATA%\PRSLOY ──
$uninstaller = Join-Path $installDir 'Uninstall PRSLOY.exe'
$report.uninstall = Watch 'uninstall' { Start-Process -FilePath $uninstaller -PassThru } 180
# NSIS's uninstaller re-runs itself from %TEMP% and exits at once; that copy deletes the files a moment
# later, possibly after Watch saw the first process go. Wait for the program like a person would (#32).
$goneAt = Get-Date
$goneDeadline = $goneAt.AddSeconds(60)
while ((Test-Path -LiteralPath $exe) -and (Get-Date) -lt $goneDeadline) { Start-Sleep -Milliseconds 500 }
$report.uninstall.exeGoneAfterSeconds = [math]::Round(((Get-Date) - $goneAt).TotalSeconds, 1)
$report.programFolderRemoved = -not (Test-Path -LiteralPath $exe)
$report.appDataKept = Test-Path -LiteralPath $appData
# Verified kept; now give the later smoke tests a fresh runner again (the upgrade test needs a
# missing %APPDATA%\PRSLOY, the reinstall test builds its own profile).
if ($report.appDataKept) { Remove-Item -LiteralPath $appData -Recurse -Force -ErrorAction SilentlyContinue }

$fail = @()
if ($report.requestedExecutionLevel -ne 'asInvoker') { $fail += "installer asks for $($report.requestedExecutionLevel), not asInvoker" }
foreach ($phase in 'install', 'uninstall') {
  $r = $report[$phase]
  if ($r.wizardWords.Count) { $fail += "${phase}: wizard text $($r.wizardWords -join ' ; ')" }
  if ($r.englishTexts.Count) { $fail += "${phase}: not Russian $($r.englishTexts -join ' ; ')" }
  if (-not $r.finishedOnItsOwn) { $fail += "${phase}: still running after $($r.seconds) s" }
}
if (-not $report.installedExe) { $fail += 'PRSLOY.exe not installed' }
if (-not $report.appStartedAfterFinish) { $fail += 'app did not start after the install (runAfterFinish)' }
if (-not $report.perUserUninstallKey) { $fail += 'no per-user (HKCU) uninstall entry' }
if (-not $report.programFolderRemoved) { $fail += 'uninstall left PRSLOY.exe' }
if ($report.appDataCreated -and -not $report.appDataKept) { $fail += 'uninstall removed %APPDATA%\PRSLOY' }
$report.failures = $fail
$report | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $OutDir 'oneclick.json')
Get-Content (Join-Path $OutDir 'oneclick.json')
if ($Strict -and $fail.Count) { throw "one-click installer: $($fail -join ' | ')" }
