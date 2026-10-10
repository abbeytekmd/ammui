<# :
@echo off
rem ---------------------------------------------------------------------------
rem AMMUI setup for Windows: a one-off bootstrap.
rem
rem Double-click this file. It installs anything missing (Node.js, Git and the
rem optional ffmpeg, yt-dlp and fpcalc helpers), fetches the latest AMMUI code
rem from GitHub, installs its packages, adds shortcuts and starts the server.
rem
rem Usage:  ammui-setup.cmd [install folder]   (default: %USERPROFILE%\ammui)
rem
rem Environment switches: AMMUI_NO_EXTRAS=1 skips ffmpeg/yt-dlp/fpcalc,
rem AMMUI_NO_RUN=1 sets everything up without starting the server,
rem AMMUI_NO_STARTUP=1 does not start AMMUI when Windows starts.
rem
rem This file is both a batch file and a PowerShell script: cmd runs this
rem header, which hands the whole file to PowerShell, where the header is just
rem a comment.
rem ---------------------------------------------------------------------------
set "AMMUI_SELF=%~f0"
set "AMMUI_INSTALL_DIR=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:AMMUI_SELF))" || pause & exit /b
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar in PowerShell 5
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RepoUrl     = 'https://github.com/abbeytekmd/ammui.git'
$RepoZip     = 'https://codeload.github.com/abbeytekmd/ammui/zip/refs/heads/main'
$Branch      = 'main'
$MinNode     = [version]'22.13.0'   # node:sqlite without a flag
$HttpPort    = 3000
$HttpsPort   = 3443

$InstallDir = if ($env:AMMUI_INSTALL_DIR) { $env:AMMUI_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'ammui' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir.Trim('"'))

# Files kept outside the code folder: the icon, the uninstaller and the kiosk browser profile.
$AppDataDir = Join-Path $env:LOCALAPPDATA 'AMMUI'
$AppIcon    = Join-Path $AppDataDir 'ammui.ico'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AMMUI'

$Host.UI.RawUI.WindowTitle = 'AMMUI setup'

function Step($msg)  { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Info($msg)  { Write-Host "    $msg" }
function Warn($msg)  { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }
# throw rather than exit, which would close the window when run as 'irm ... | iex'.
function Fail($msg)  { Write-Host ''; Write-Host "ERROR: $msg" -ForegroundColor Red; throw 'AMMUI setup failed.' }

function Update-SessionPath {
    # Pick up PATH changes made by installers that ran after this window opened.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $extra   = @("$env:ProgramFiles\nodejs", "$env:ProgramFiles\Git\cmd") | Where-Object { Test-Path $_ }
    $env:Path = (@($machine, $user) + $extra | Where-Object { $_ }) -join ';'
}

function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Test-Winget { Test-Command 'winget' }

function Install-WithWinget($id) {
    Info "Installing $id with winget (Windows may ask for permission)..."
    & winget install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host
    $code = $LASTEXITCODE
    Update-SessionPath
    return $code
}

function Get-File($url, $dest) {
    Info "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers @{ 'User-Agent' = 'ammui-setup' }
}

function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("ammui-setup-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    return $d
}

# --- Node.js -----------------------------------------------------------------

function Get-NodeVersion {
    if (-not (Test-Command 'node')) { return $null }
    try { return [version]((& node --version) -replace '^v', '') } catch { return $null }
}

function Install-NodeFromMsi {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -and $_.files -contains "win-$arch-msi" } | Select-Object -First 1
    if (-not $lts) { Fail 'Could not find a Node.js LTS installer on nodejs.org.' }
    $tmp = New-TempDir
    $msi = Join-Path $tmp "node-$($lts.version)-$arch.msi"
    Get-File "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$arch.msi" $msi
    Info "Running the Node.js $($lts.version) installer (Windows may ask for permission)..."
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart' -Wait -PassThru
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "The Node.js installer failed (exit code $($p.ExitCode))." }
    Update-SessionPath
}

function Install-Node {
    Step 'Checking Node.js'
    $v = Get-NodeVersion
    if ($v -and $v -ge $MinNode) { Info "Node.js $v found."; return }
    if ($v) { Info "Node.js $v is too old (AMMUI needs $MinNode or newer)." } else { Info 'Node.js is not installed.' }

    if (Test-Winget) {
        if ($v) { & winget upgrade --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host; Update-SessionPath }
        if (-not ((Get-NodeVersion) -ge $MinNode)) { Install-WithWinget 'OpenJS.NodeJS.LTS' | Out-Null }
    }
    if (-not ((Get-NodeVersion) -ge $MinNode)) { Install-NodeFromMsi }

    $v = Get-NodeVersion
    if (-not $v) { Fail 'Node.js was installed but cannot be found. Close this window and run the installer again.' }
    if ($v -lt $MinNode) {
        $where = (Get-Command node).Source
        Fail "Node.js $v at $where is still older than $MinNode. An older copy (for example one managed by nvm) is earlier on your PATH; update or remove it and run the installer again."
    }
    Info "Node.js $v ready."
}

# --- Git ---------------------------------------------------------------------

function Install-Git {
    Step 'Checking Git'
    if (Test-Command 'git') { Info "$(& git --version) found."; return $true }
    if (Test-Winget) {
        Install-WithWinget 'Git.Git' | Out-Null
        if (Test-Command 'git') { Info "$(& git --version) ready."; return $true }
    }
    Warn 'Git could not be installed; the code will be downloaded as a zip file instead.'
    return $false
}

# --- AMMUI code --------------------------------------------------------------

function Get-CodeAsZip {
    Step "Downloading the latest AMMUI code to $InstallDir"
    $tmp = New-TempDir
    $zip = Join-Path $tmp 'ammui.zip'
    Get-File $RepoZip $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $src.FullName '*') -Destination $InstallDir -Recurse -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-CodeWithGit {
    $isRepo = Test-Path (Join-Path $InstallDir '.git')
    $hasFiles = (Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Select-Object -First 1)

    if ($isRepo) {
        Step "Updating AMMUI in $InstallDir"
        & git -C $InstallDir pull --ff-only | Out-Host
        if ($LASTEXITCODE -ne 0) { Warn 'Could not update the code (files in the folder have been changed locally?). Starting the existing version.' }
    } elseif (-not $hasFiles) {
        Step "Downloading AMMUI to $InstallDir"
        & git clone --branch $Branch $RepoUrl $InstallDir | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail 'git clone failed. Check your internet connection and try again.' }
    } elseif (Test-Path (Join-Path $InstallDir 'server.js')) {
        # An existing copy that was not cloned (e.g. unpacked from a zip): turn it into a clone,
        # keeping the database, settings and other files that are not part of the code.
        Step "Converting the existing AMMUI folder $InstallDir to a Git copy"
        & git -C $InstallDir init -q
        & git -C $InstallDir remote add origin $RepoUrl
        & git -C $InstallDir fetch origin $Branch | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed. Check your internet connection and try again.' }
        & git -C $InstallDir checkout -f -B $Branch "origin/$Branch" | Out-Host
        & git -C $InstallDir branch -u "origin/$Branch" | Out-Null
    } else {
        Fail "$InstallDir already exists and does not look like AMMUI. Choose another folder: ammui-setup.cmd C:\path\to\ammui"
    }
}

function Install-Packages {
    Step 'Installing AMMUI packages'
    # npm ci only when the lock file changed: it starts from scratch each time and, unlike
    # npm install, never rewrites package-lock.json (which would block the next git pull).
    $lock = Join-Path $InstallDir 'package-lock.json'
    $stamp = Join-Path $InstallDir 'node_modules\.ammui-lock-hash'
    $hash = (Get-FileHash $lock -Algorithm SHA256).Hash
    if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $hash)) { Info 'Packages are up to date.'; return }
    Push-Location $InstallDir
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the packages. See the messages above.' }
    } finally { Pop-Location }
    Set-Content -Path $stamp -Value $hash -Encoding ascii
}

# --- Optional helper programs (dropped in the app folder, which AMMUI adds to its PATH) ---

function Test-Helper($exe) { (Test-Path (Join-Path $InstallDir $exe)) -or (Test-Command $exe) }

function Install-Helpers {
    if ($env:AMMUI_NO_EXTRAS -eq '1') { return }
    Step 'Checking optional helpers (ffmpeg, yt-dlp, fpcalc)'

    try {
        if ((Test-Helper 'ffmpeg.exe') -and (Test-Helper 'ffprobe.exe')) { Info 'ffmpeg found.' }
        else {
            $tmp = New-TempDir
            $zip = Join-Path $tmp 'ffmpeg.zip'
            Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
                $f = Get-ChildItem $tmp -Recurse -Filter $exe | Select-Object -First 1
                Copy-Item $f.FullName (Join-Path $InstallDir $exe) -Force
            }
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Info 'ffmpeg installed.'
        }
    } catch { Warn "ffmpeg could not be installed ($($_.Exception.Message)). AirPlay, thumbnails and local video playback need it." }

    try {
        $local = Join-Path $InstallDir 'yt-dlp.exe'
        if (Test-Path $local) {
            # YouTube changes often; an out of date yt-dlp stops working.
            & $local -U | Select-Object -Last 1 | ForEach-Object { Info "yt-dlp: $_" }
        } elseif (Test-Command 'yt-dlp.exe') { Info 'yt-dlp found.' }
        else {
            Get-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $local
            Info 'yt-dlp installed.'
        }
    } catch { Warn "yt-dlp could not be installed ($($_.Exception.Message)). Videos with embedding disabled will open on youtube.com." }

    try {
        if (Test-Helper 'fpcalc.exe') { Info 'fpcalc found.' }
        else {
            $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/acoustid/chromaprint/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'ammui-setup' }
            $asset = $rel.assets | Where-Object { $_.name -match 'fpcalc.*windows-x86_64\.zip$' } | Select-Object -First 1
            if (-not $asset) { throw 'no Windows build in the latest Chromaprint release' }
            $tmp = New-TempDir
            $zip = Join-Path $tmp 'fpcalc.zip'
            Get-File $asset.browser_download_url $zip
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            $f = Get-ChildItem $tmp -Recurse -Filter 'fpcalc.exe' | Select-Object -First 1
            Copy-Item $f.FullName (Join-Path $InstallDir 'fpcalc.exe') -Force
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Info 'fpcalc installed.'
        }
    } catch { Warn "fpcalc could not be installed ($($_.Exception.Message)). 'Identify with AcoustID' will be unavailable." }
}

# --- Icon, Settings > Apps entry and uninstaller -------------------------------

function New-AppIcon {
    # An .ico made from the app's PNG icon, for the shortcuts and the Settings > Apps entry.
    # The 256px image is stored as PNG; smaller ones as 32-bit bitmaps, which is what
    # everything that reads icons understands.
    try {
        $png = Join-Path $InstallDir 'public\amm-icon.png'
        if (-not (Test-Path $png)) { return }
        Add-Type -AssemblyName System.Drawing
        New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
        $src = [Drawing.Image]::FromFile($png)
        $images = foreach ($size in 256, 48, 32, 16) {
            $bmp = New-Object Drawing.Bitmap $size, $size
            $g = [Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.DrawImage($src, 0, 0, $size, $size)
            $g.Dispose()
            $ms = New-Object IO.MemoryStream
            if ($size -ge 256) {
                $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
            } else {
                # BITMAPINFOHEADER (height doubled for the AND mask), BGRA rows bottom-up, empty AND mask.
                $bw = New-Object IO.BinaryWriter $ms
                $maskRow = [int]([math]::Ceiling($size / 32) * 4)
                $bw.Write([uint32]40); $bw.Write([int32]$size); $bw.Write([int32]($size * 2))
                $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
                $bw.Write([uint32]($size * $size * 4 + $maskRow * $size))
                $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
                $data = $bmp.LockBits((New-Object Drawing.Rectangle 0, 0, $size, $size), [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
                $row = New-Object byte[] ($size * 4)
                for ($y = $size - 1; $y -ge 0; $y--) {
                    [Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride), $row, 0, $row.Length)
                    $bw.Write($row)
                }
                $bmp.UnlockBits($data)
                $bw.Write((New-Object byte[] ($maskRow * $size)))
                $bw.Flush()
            }
            $bmp.Dispose()
            ,@($size, $ms.ToArray())
        }
        $src.Dispose()
        $out = New-Object IO.MemoryStream
        $w = New-Object IO.BinaryWriter $out
        $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
        $offset = 6 + 16 * $images.Count
        foreach ($img in $images) {
            $dim = if ($img[0] -ge 256) { 0 } else { $img[0] }   # 0 means 256
            $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
            $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$img[1].Length); $w.Write([uint32]$offset)
            $offset += $img[1].Length
        }
        foreach ($img in $images) { $w.Write([byte[]]$img[1]) }
        $w.Flush()
        [IO.File]::WriteAllBytes($AppIcon, $out.ToArray())
    } catch { Warn "Could not create the AMMUI icon ($($_.Exception.Message))." }
}

# The uninstaller, written next to the icon with the install folder filled in. It is run from
# Settings > Apps (or by hand) after this setup file is long gone, so it has to stand alone.
$UninstallScript = @'
# AMMUI uninstaller, written by ammui-setup.cmd. Run it from Settings > Apps, or with:
#   powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\AMMUI\uninstall.ps1"
$InstallDir = '__INSTALL_DIR__'
$AppDataDir = Join-Path $env:LOCALAPPDATA 'AMMUI'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AMMUI'

$Host.UI.RawUI.WindowTitle = 'Uninstall AMMUI'
Add-Type -AssemblyName System.Windows.Forms
function Ask($text, $buttons, $icon, $default) {
    [Windows.Forms.MessageBox]::Show($text, 'Uninstall AMMUI', [Windows.Forms.MessageBoxButtons]$buttons,
        [Windows.Forms.MessageBoxIcon]$icon, [Windows.Forms.MessageBoxDefaultButton]$default)
}
function Info($msg) { Write-Host "    $msg" }

if ((Ask "Remove AMMUI from this PC?`n`nThis stops the AMMUI server and removes its shortcuts and its entry in Settings > Apps." 'OKCancel' 'Question' 'Button1') -ne 'OK') { exit }
$deleteFolder = $false
if (Test-Path -LiteralPath $InstallDir) {
    $deleteFolder = (Ask ("Also delete the AMMUI folder?`n`n$InstallDir`n`n" +
        "It holds your AMMUI database and settings, and the local library: the music, photos and videos " +
        "added to AMMUI's own server. Back it up first if you want to keep any of it. " +
        "Music and photo folders elsewhere on this PC are not touched.`n`n" +
        "Yes: delete the folder and everything in it.`nNo: keep the folder.") 'YesNo' 'Warning' 'Button2') -eq 'Yes'
}

Write-Host 'Uninstalling AMMUI' -ForegroundColor Green

# Stop the server and the kiosk browser, which hold files in the folders being removed.
foreach ($port in 3000, 3443) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $proc = if ($conn) { Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
    if ($proc -and $proc.ProcessName -eq 'node') { Info 'Stopping the AMMUI server.'; Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
$kioskProfile = Join-Path $AppDataDir 'kiosk-browser'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($kioskProfile) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$links = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'AMMUI Server.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'AMMUI Server.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Startup'))  'AMMUI Server.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop'))  'AMMUI Kiosk.lnk'))
foreach ($l in $links) { if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l -Force; Info "Removed $l" } }

# Stop trusting AMMUI's certificate (Windows asks to confirm).
$caPath = Join-Path $InstallDir 'certs\ca.crt'
if (Test-Path -LiteralPath $caPath) {
    try {
        $ca = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $caPath
        $trusted = Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $ca.Thumbprint
        if ($trusted) { Info 'Removing the AMMUI certificate: choose Yes in the Windows prompt.'; $trusted | Remove-Item -ErrorAction Stop }
    } catch { Write-Host "    The AMMUI certificate is still trusted ($($_.Exception.Message))." -ForegroundColor Yellow }
}

$kept = $null
if ($deleteFolder) {
    Info "Deleting $InstallDir"
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $InstallDir) { $kept = "Some files in $InstallDir could not be deleted (in use?). Delete the folder yourself." }
} elseif (Test-Path -LiteralPath $InstallDir) {
    $kept = "Your AMMUI folder was kept: $InstallDir"
}

Remove-Item -Path $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
Set-Location $env:TEMP
Remove-Item -LiteralPath $AppDataDir -Recurse -Force -ErrorAction SilentlyContinue   # icon, kiosk profile and this script

$done = "AMMUI has been removed.`n`nNode.js and Git were left installed. Remove them from Settings > Apps if nothing else uses them."
if ($kept) { $done += "`n`n$kept" }
Ask $done 'OK' 'Information' 'Button1' | Out-Null
'@

function Register-Uninstaller {
    # Lists AMMUI in Settings > Apps (and Control Panel > Programs) for this user, with an
    # Uninstall button. Per-user, so no administrator rights are needed.
    try {
        New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
        $script = Join-Path $AppDataDir 'uninstall.ps1'
        $text = $UninstallScript.Replace('__INSTALL_DIR__', $InstallDir.Replace("'", "''"))
        [IO.File]::WriteAllText($script, $text, [Text.Encoding]::ASCII)

        $version = try { (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch { '' }
        New-Item -Path $UninstallKey -Force | Out-Null
        $values = @{
            DisplayName     = 'AMMUI Media Hub'
            DisplayVersion  = $version
            Publisher       = 'AMMUI'
            URLInfoAbout    = 'https://github.com/abbeytekmd/ammui'
            InstallLocation = $InstallDir
            InstallDate     = (Get-Date -Format 'yyyyMMdd')
            UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
        }
        if (Test-Path $AppIcon) { $values.DisplayIcon = $AppIcon }
        foreach ($k in $values.Keys) { New-ItemProperty -Path $UninstallKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
        foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $UninstallKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
        Info 'Added AMMUI to Settings > Apps, where it can be uninstalled.'
    } catch { Warn "Could not add AMMUI to Settings > Apps ($($_.Exception.Message))." }
}

# --- Shortcuts and running ---------------------------------------------------

function New-Shortcuts {
    # Shortcuts that start the server itself (not this setup): Start menu and desktop, plus the
    # Startup folder so it runs, minimised, when this user signs in to Windows.
    try {
        $shell = New-Object -ComObject WScript.Shell
        $node = (Get-Command node).Source
        $links = @(
            @{ Folder = [Environment]::GetFolderPath('Programs'); Style = 1 },
            @{ Folder = [Environment]::GetFolderPath('Desktop');  Style = 1 })
        $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'AMMUI Server.lnk'
        if ($env:AMMUI_NO_STARTUP -eq '1') {
            if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force; Info 'Removed AMMUI from the Windows Startup folder.' }
        } else {
            $links += @{ Folder = [Environment]::GetFolderPath('Startup'); Style = 7 }   # 7 = minimised
        }
        foreach ($l in $links) {
            $lnk = $shell.CreateShortcut((Join-Path $l.Folder 'AMMUI Server.lnk'))
            $lnk.TargetPath = $env:ComSpec
            $lnk.Arguments = "/s /c `"title AMMUI server - close this window to stop & `"$node`" server.js`""
            $lnk.WorkingDirectory = $InstallDir
            $lnk.IconLocation = if (Test-Path $AppIcon) { "$AppIcon,0" } else { "$node,0" }
            $lnk.WindowStyle = $l.Style
            $lnk.Description = 'Start the AMMUI server (close its window to stop it)'
            $lnk.Save()
        }
        Info "Added 'AMMUI Server' shortcuts to the Start menu and desktop."
        if ($env:AMMUI_NO_STARTUP -ne '1') { Info 'AMMUI will start (minimised) when you sign in to Windows.' }
    } catch { Warn "Could not create shortcuts ($($_.Exception.Message))." }
}

function Find-Browser($exe, $fallbacks) {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
        $p = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
        if ($p -and (Test-Path $p.Trim('"'))) { return $p.Trim('"') }
    }
    return $fallbacks | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function New-KioskShortcut {
    # Full-screen browser showing the local server, e.g. for a wall display. It uses its own
    # browser profile: kiosk mode is ignored when the window joins an already running browser.
    try {
        $browser = Find-Browser 'chrome.exe' @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
        $extra = ''
        $name = 'Chrome'
        if (-not $browser) {
            $browser = Find-Browser 'msedge.exe' @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
            $extra = ' --edge-kiosk-type=fullscreen'
            $name = 'Edge'
            if (-not $browser) { Warn 'Chrome was not found, so no kiosk shortcut was created.'; return }
            Warn 'Chrome was not found; the kiosk shortcut uses Microsoft Edge instead.'
        }
        $profileDir = Join-Path $AppDataDir 'kiosk-browser'
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AMMUI Kiosk.lnk'))
        $lnk.TargetPath = $browser
        $lnk.Arguments = "--kiosk$extra --user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required https://localhost:$HttpsPort/"
        $lnk.IconLocation = "$browser,0"
        $lnk.Description = 'AMMUI full screen (Alt+F4 to close). The AMMUI server must be running.'
        $lnk.Save()
        Info "Added an 'AMMUI Kiosk' desktop shortcut ($name, full screen; Alt+F4 closes it)."
    } catch { Warn "Could not create the kiosk shortcut ($($_.Exception.Message))." }
}

function Grant-CertificateTrust {
    # Trust AMMUI's own certificate authority for this Windows user, so the browser (and the
    # kiosk window, which has no easy way past the warning) opens the page without a warning.
    # Windows asks for confirmation; saying No just leaves the warning in place.
    try {
        $caPath = Join-Path $InstallDir 'certs\ca.crt'
        if (-not (Test-Path $caPath)) { return }
        $ca = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $caPath
        $trusted = Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $ca.Thumbprint
        if ($trusted) { return }
        Info 'Trusting the AMMUI certificate on this PC: choose Yes in the Windows security prompt.'
        Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
        Info 'Certificate trusted. Restart any browser windows that were already open.'
    } catch { Warn "The AMMUI certificate was not trusted, so browsers will show a warning ($($_.Exception.Message))." }
}

function Stop-RunningServer {
    # The server has to be stopped to update it, and a second copy could not open the ports.
    foreach ($port in $HttpPort, $HttpsPort) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $conn) { continue }
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
            Info "Stopping the AMMUI server that is already running (process $($proc.Id))."
            Stop-Process -Id $proc.Id -Force
            Start-Sleep -Seconds 1
        } else {
            $name = if ($proc) { $proc.ProcessName } else { 'another program' }
            Fail "Port $port is in use by $name, so AMMUI cannot start. Close it and run the installer again."
        }
    }
}

function Start-Server {
    Step 'Starting AMMUI'
    $url = "https://localhost:$HttpsPort/"
    Write-Host ''
    Write-Host "    AMMUI is starting: $url" -ForegroundColor Green
    Write-Host "    From other devices use https://$($env:COMPUTERNAME):$HttpsPort/ (or this PC's IP address)."
    Write-Host '    If Windows Firewall asks about Node.js, allow it on private networks so players and other devices can connect.'
    Write-Host '    Close this window to stop AMMUI.' -ForegroundColor Green
    Write-Host ''

    $Host.UI.RawUI.WindowTitle = 'AMMUI server (close this window to stop)'
    Set-Location $InstallDir
    # The server shares this window for its log. Once it is listening (its certificate exists
    # by then), trust the certificate and open the browser.
    $server = Start-Process (Get-Command node).Source -ArgumentList 'server.js' -NoNewWindow -PassThru
    $null = $server.Handle   # keep a handle so ExitCode is available afterwards
    for ($i = 0; $i -lt 120 -and -not $server.HasExited; $i++) {
        try { (New-Object Net.Sockets.TcpClient('localhost', $HttpsPort)).Close(); break } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $server.HasExited) {
        Grant-CertificateTrust
        Start-Process $url
    }
    $server.WaitForExit()
    Write-Host ''
    Warn "The AMMUI server stopped (exit code $($server.ExitCode))."
    Read-Host 'Press Enter to close'
}

# --- Main --------------------------------------------------------------------

Write-Host 'AMMUI setup' -ForegroundColor Green
Info "Install folder: $InstallDir"

try {
    Update-SessionPath
    Install-Node
    $haveGit = Install-Git
    Stop-RunningServer
    if ($haveGit) { Get-CodeWithGit } else { Get-CodeAsZip }
    if (-not (Test-Path (Join-Path $InstallDir 'server.js'))) { Fail "The AMMUI code was not found in $InstallDir." }
    Install-Packages
    Install-Helpers
    New-AppIcon
    New-Shortcuts
    New-KioskShortcut
    Register-Uninstaller

    if ($env:AMMUI_NO_RUN -eq '1') { Step "AMMUI is installed in $InstallDir" } else { Start-Server }
} catch {
    if ($_.Exception.Message -ne 'AMMUI setup failed.') { Write-Host ''; Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red }
    if ($env:AMMUI_SELF) { exit 1 }   # started from the .cmd: make it pause so the message can be read
}
