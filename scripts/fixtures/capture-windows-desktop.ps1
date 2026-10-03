$ErrorActionPreference = 'Stop'
$captureErrors = [System.Collections.Generic.List[object]]::new()
$dumpResults = [System.Collections.Generic.List[object]]::new()
$report = [ordered]@{ pid=$null; title=$null; responding=$null; session=$null; captureSession=$env:GROKBOT_CAPTURE_SESSION; screenshot=$env:GROKBOT_CAPTURE_PATH }
$rootHandle = [IntPtr]::Zero

function Add-CaptureError([string]$stage, [object]$failure) {
  $message = $failure.ToString()
  $captureErrors.Add(@{ stage=$stage; message=$message })
  [Console]::Error.WriteLine("${stage}: $message")
}

function Write-CaptureDump([object]$expected, [string]$role, [IntPtr]$existingHandle, [object]$rootIdentity, [string]$directory, [string]$sessionPattern) {
  $handle = $existingHandle
  $ownsHandle = $handle -eq [IntPtr]::Zero
  $stream = $null
  $target = Join-Path $directory ("native-{0}-{1}.dmp" -f $role, $expected.ProcessId)
  $result = [ordered]@{ pid=[uint32]$expected.ProcessId; role=$role; file=$target; type='MiniDumpNormal|MiniDumpWithThreadInfo'; success=$false }
  try {
    if ($null -eq $expected.CreationDate) { throw 'Process creation time is unavailable' }
    if ($ownsHandle) {
      $handle = [GrokBotCapture.NativeMethods]::OpenProcess(0x0410, $false, [uint32]$expected.ProcessId)
      if ($handle -eq [IntPtr]::Zero) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    }
    # 持有进程 handle 后重新核验，防止 PID 被其他进程重新使用。
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $expected.ProcessId)
    if (!$current -or $current.CreationDate -ne $expected.CreationDate) { throw 'Process identity changed before dump capture' }
    if ($role -eq 'main') {
      if ($current.CommandLine -notmatch $sessionPattern) { throw 'Root process session changed before dump capture' }
    } else {
      if ($current.ParentProcessId -ne $rootIdentity.ProcessId -or $current.CreationDate -lt $rootIdentity.CreationDate -or $current.CommandLine -notmatch '(?:^|\s)(?:"--type=renderer"|--type=renderer)(?=\s|$)') { throw 'Renderer ownership changed before dump capture' }
    }
    $stream = [System.IO.FileStream]::new($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    # 仅使用普通转储和线程信息，不包含 FullMemory 或 heap 标志。
    $ok = [GrokBotCapture.NativeMethods]::MiniDumpWriteDump($handle, [uint32]$expected.ProcessId, $stream.SafeFileHandle, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
    if (!$ok) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $stream.Flush()
    $result.success = $true
  } catch {
    $result.error = $_.ToString()
    Add-CaptureError "dump-$role-$($expected.ProcessId)" $_
  } finally {
    if ($stream) {
      try { $stream.Dispose() } catch { $result.success = $false; Add-CaptureError "dump-file-close-$role" $_ }
    }
    if ($ownsHandle -and $handle -ne [IntPtr]::Zero) {
      if (![GrokBotCapture.NativeMethods]::CloseHandle($handle)) {
        $result.success = $false
        Add-CaptureError "dump-process-close-$role" ([System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
      }
    }
    $dumpResults.Add($result)
  }
}

try {
  if ($env:GROKBOT_CAPTURE_SESSION -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'GROKBOT_CAPTURE_SESSION must be an exact UUID' }
  $rootPid = [uint32]::Parse($env:GROKBOT_CAPTURE_PID)
  if ($rootPid -eq 0 -or $rootPid -eq $PID) { throw 'Invalid root process ID for capture' }
  $report.pid = $rootPid
  if ([string]::IsNullOrWhiteSpace($env:GROKBOT_CAPTURE_PATH)) { throw 'GROKBOT_CAPTURE_PATH is required' }
  $capturePath = [System.IO.Path]::GetFullPath($env:GROKBOT_CAPTURE_PATH)
  $directory = [System.IO.Path]::GetDirectoryName($capturePath)
  if (![System.IO.Directory]::Exists($directory)) { throw 'Capture output directory does not exist' }
  $escapedSession = [Regex]::Escape($env:GROKBOT_CAPTURE_SESSION)
  $sessionPattern = '(?:^|\s)(?:"--grokbot-local-session=' + $escapedSession + '"|--grokbot-local-session=' + $escapedSession + ')(?=\s|$)'
  $rootIdentity = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $rootPid)
  if (!$rootIdentity -or $null -eq $rootIdentity.CreationDate -or $rootIdentity.CommandLine -notmatch $sessionPattern) { throw 'Root process does not carry the requested capture session and creation time' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace GrokBotCapture {
  public static class NativeMethods {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("dbghelp.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MiniDumpWriteDump(IntPtr processHandle, uint processId, SafeFileHandle fileHandle, uint dumpType, IntPtr exceptionParam, IntPtr userStreamParam, IntPtr callbackParam);
  }
}
'@
  $rootHandle = [GrokBotCapture.NativeMethods]::OpenProcess(0x0410, $false, $rootPid)
  if ($rootHandle -eq [IntPtr]::Zero) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $confirmedRoot = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $rootPid)
  if (!$confirmedRoot -or $confirmedRoot.CreationDate -ne $rootIdentity.CreationDate -or $confirmedRoot.CommandLine -notmatch $sessionPattern) { throw 'Root identity changed before desktop capture' }
  try {
    $appProcess = Get-Process -Id $rootPid
    try {
      $report.title = $appProcess.MainWindowTitle
      $report.responding = $appProcess.Responding
      $report.session = $appProcess.SessionId
    } finally { $appProcess.Dispose() }
  } catch { Add-CaptureError 'process-metadata' $_ }
  $children = @()
  try {
    $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = {0}" -f $rootPid))
    $report.children = @($children | ForEach-Object { @{ pid=[uint32]$_.ProcessId; parentPid=[uint32]$_.ParentProcessId; name=$_.Name } })
  } catch { Add-CaptureError 'child-process-metadata' $_ }
  $bitmap = $null
  $graphics = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Png)
  } catch { Add-CaptureError 'screenshot' $_ }
  finally {
    if ($graphics) { try { $graphics.Dispose() } catch { Add-CaptureError 'screenshot-graphics-close' $_ } }
    if ($bitmap) { try { $bitmap.Dispose() } catch { Add-CaptureError 'screenshot-bitmap-close' $_ } }
  }
  Write-CaptureDump $rootIdentity 'main' $rootHandle $rootIdentity $directory $sessionPattern
  $renderers = @($children | Where-Object { $_.CommandLine -match '(?:^|\s)(?:"--type=renderer"|--type=renderer)(?=\s|$)' })
  if ($renderers.Count -eq 0) { throw 'No direct renderer child exists for the captured root' }
  foreach ($renderer in $renderers) { Write-CaptureDump $renderer 'renderer' ([IntPtr]::Zero) $rootIdentity $directory $sessionPattern }
} catch { Add-CaptureError 'capture' $_ }
finally {
  if ($rootHandle -ne [IntPtr]::Zero) {
    if (![GrokBotCapture.NativeMethods]::CloseHandle($rootHandle)) { Add-CaptureError 'root-process-close' ([System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())) }
  }
}
$report.dumps = $dumpResults.ToArray()
$report.errors = $captureErrors.ToArray()
$report | ConvertTo-Json -Depth 6 -Compress
if ($captureErrors.Count -gt 0) { exit 1 }
