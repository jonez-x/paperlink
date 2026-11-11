# Installs Paperlink for this user on Windows: its own Node.js in
# %LOCALAPPDATA%\Paperlink\node (no admin rights, any existing Node stays
# untouched), the app in ...\app and a `paper` command, then runs `paper setup`.
# Running it again updates Paperlink. Started by "Install Paperlink.cmd".
param([string]$Package = (Join-Path $PSScriptRoot 'paperlink.tgz'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeLine = 22
$Root = if ($env:PAPERLINK_HOME) { $env:PAPERLINK_HOME } else { Join-Path $env:LOCALAPPDATA 'Paperlink' }
function Say($text) { Write-Host "  $text" }
function Fail($text) { Write-Host "  x $text" -ForegroundColor Red; exit 1 }
# Folders from an earlier swap; -like, because -Filter 'node.*' would also match node.
function Remove-NodeLeftovers {
  Get-ChildItem $Root -Directory | Where-Object { $_.Name -like 'node.new-*' -or $_.Name -like 'node.old-*' } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $Package)) { Fail 'paperlink.tgz not found next to this script.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('paperlink-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work, $Root | Out-Null

try {
  # A running server is stopped before Node and the app are replaced; setup restarts it.
  $bin = Join-Path $Root 'bin'
  $paper = Join-Path $bin 'paper.cmd'
  if (Test-Path $paper) { try { & $paper stop *> $null } catch {} }

  # Node.js: the latest release of the supported line, checked against nodejs.org's checksums.
  $base = "https://nodejs.org/dist/latest-v$NodeLine.x"
  try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content } catch { Fail 'Cannot reach nodejs.org. Check the internet connection.' }
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match "  (node-v[0-9.]+-win-$arch\.zip)$" } | Select-Object -First 1
  if (-not $line) { Fail "No Node.js download for win-$arch." }
  $expected, $archive = $line.Trim() -split '\s+'
  $version = $archive -replace "^node-|-win-$arch\.zip$", ''
  $nodeDir = Join-Path $Root 'node'
  # Reused only when the recorded version matches and node.exe still runs.
  $installed = Get-Content (Join-Path $nodeDir 'VERSION') -ErrorAction SilentlyContinue
  $runs = $false
  if ($installed -eq $version) { try { $runs = ((& (Join-Path $nodeDir 'node.exe') --version) -eq $version) } catch {} }
  Remove-NodeLeftovers
  if ($runs) {
    Say "Node.js $version is already here"
  } else {
    Say "Downloading Node.js $version ..."
    $zip = Join-Path $work $archive
    Invoke-WebRequest -UseBasicParsing "$base/$archive" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $expected) { Fail 'The Node.js download is damaged (checksum mismatch). Try again.' }
    # Unpacked next to the old folder, then swapped by renaming, so a node.exe
    # that is still in use leaves the old Node complete.
    $staging = Join-Path $Root ('node.new-' + [Guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    tar -xf $zip -C $staging
    if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack Node.js.' }
    $fresh = Join-Path $staging ($archive -replace '\.zip$', '')
    Set-Content -Path (Join-Path $fresh 'VERSION') -Value $version
    if (Test-Path $nodeDir) {
      try { Rename-Item $nodeDir ('node.old-' + [Guid]::NewGuid()) }
      catch {
        Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
        Fail 'Node.js is still in use. Quit Claude Desktop, Cursor and other apps that use Paperlink, then run the installer again.'
      }
    }
    Move-Item $fresh $nodeDir
    Remove-NodeLeftovers
    Say "Node.js $version"
  }

  # Paperlink itself.
  tar -xzf $Package -C $work
  if ($LASTEXITCODE -ne 0) { Fail 'Could not unpack paperlink.tgz.' }
  $app = Join-Path $Root 'app'
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  Move-Item (Join-Path $work 'package') $app
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  # Relative paths keep this file ASCII even when the user name is not.
  Set-Content -Path $paper -Encoding ASCII -Value '@"%~dp0..\node\node.exe" "%~dp0..\app\bin\paper.js" %*'
  Say ('Paperlink ' + (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version)

  # `paper` in new terminals, and a Start menu entry that opens the menu.
  # The raw value keeps %VARIABLE% entries, and it is written back as REG_EXPAND_SZ.
  $environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $userPath = $environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if (-not (($userPath -split ';') -contains $bin)) {
    $environment.SetValue('Path', ($bin + ';' + $userPath).TrimEnd(';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    # Removing an unset variable tells open programs (Explorer) that the environment changed.
    [Environment]::SetEnvironmentVariable('PAPERLINK_INSTALLER', $null, 'User')
  }
  $environment.Close()
  $env:Path = $bin + ';' + $env:Path
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Paperlink.lnk'))
  $shortcut.TargetPath = $paper
  $shortcut.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')
  $shortcut.Save()
  Say '`paper` works in new terminal windows, and Paperlink is in the Start menu'
  Write-Host ''
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# Setup asks questions, so only when someone is at the keyboard.
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { & $paper setup }
else { Say 'Run `paper setup` to finish.' }
