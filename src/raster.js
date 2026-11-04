import { execFile } from 'node:child_process';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Renders the first page of a one-page PDF to a PNG, about 1600 pixels on its
// longer side, with what the system already has: Quick Look on macOS, the
// Windows PDF engine (Windows 10 and newer) and Poppler's pdftoppm on Linux.
const run = promisify(execFile);

// Windows PowerShell 5.1 reaches the WinRT PDF API; paths arrive as environment
// variables, never inside the script.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asTaskResult = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
$asTaskAction = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Wait-Result($operation, $type) { $task = $asTaskResult.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait() | Out-Null; $task.Result }
function Wait-Action($action) { $asTaskAction.Invoke($null, @($action)).Wait() | Out-Null }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
$source = Wait-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:PAPERLINK_PDF)) ([Windows.Storage.StorageFile])
$document = Wait-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($source)) ([Windows.Data.Pdf.PdfDocument])
$page = $document.GetPage(0)
$options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
if ($page.Size.Height -gt $page.Size.Width) { $options.DestinationHeight = 1600 } else { $options.DestinationWidth = 1600 }
$folder = Wait-Result ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($env:PAPERLINK_PNG_FOLDER)) ([Windows.Storage.StorageFolder])
$target = Wait-Result ($folder.CreateFileAsync($env:PAPERLINK_PNG_NAME, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$stream = Wait-Result ($target.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
try { Wait-Action ($page.RenderToStreamAsync($stream, $options)) } finally { $stream.Dispose(); $page.Dispose() }
`;

// Writes <pdf>.png next to the PDF and returns its path.
export async function pdfToPng(pdf) {
  const png = pdf + '.png';
  const options = { timeout: 30000, windowsHide: true };
  if (process.platform === 'darwin') {
    await run('qlmanage', ['-t', '-s', '1600', '-o', path.dirname(pdf), pdf], options);
  } else if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { ...options, env: { ...process.env, PAPERLINK_PDF: pdf, PAPERLINK_PNG_FOLDER: path.dirname(png), PAPERLINK_PNG_NAME: path.basename(png) } });
  } else {
    // pdftoppm appends ".png" to the prefix itself.
    await run('pdftoppm', ['-png', '-singlefile', '-scale-to', '1600', pdf, pdf + '.out'], options);
    await rename(pdf + '.out.png', png);
  }
  return png;
}
