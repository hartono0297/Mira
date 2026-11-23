# Mira installer.
#
# Install or update (PowerShell, no admin needed):
#   irm https://raw.githubusercontent.com/hartono0297/Mira/main/install.ps1 | iex
#
# What it does:
#   1. Finds the newest Mira release on GitHub (prereleases included).
#   2. Downloads Mira_<version>_x64-setup.exe and checks its SHA-256 against
#      the digest GitHub publishes for the asset (or a .sha256 asset).
#   3. Closes a running Mira, runs the installer silently for the current
#      user (no admin), then starts Mira.
#
# Optional environment variables:
#   MIRA_GITHUB_TOKEN   token with read access, needed while the repository
#                       is private (also used for the raw script URL).
#   MIRA_INSTALL_DRY_RUN=1  download and verify only, install nothing.
#
# Your data (%LOCALAPPDATA%\id.mira.desktop and the laptop key in Windows
# Credential Manager) is not touched by an update.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'hartono0297/Mira'
$Api = "https://api.github.com/repos/$Repo"
$Token = $env:MIRA_GITHUB_TOKEN
$DryRun = $env:MIRA_INSTALL_DRY_RUN -eq '1'

function Say([string]$Message) { Write-Host "  $Message" }

function Get-Headers([string]$Accept = 'application/vnd.github+json') {
    $h = @{ 'User-Agent' = 'mira-installer'; 'Accept' = $Accept }
    if ($Token) { $h['Authorization'] = "Bearer $Token" }
    return $h
}

function Find-MiraExe {
    # Installed by the NSIS installer in per-user mode.
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($k in $keys) {
        $entry = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -eq 'Mira' } | Select-Object -First 1
        if ($entry -and $entry.InstallLocation) {
            $exe = Join-Path ($entry.InstallLocation.Trim('"')) 'mira.exe'
            if (Test-Path $exe) { return $exe }
        }
    }
    $fallback = Join-Path $env:LOCALAPPDATA 'Mira\mira.exe'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

Write-Host ''
Write-Host 'Mira - pasang atau perbarui'

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Mira hanya jalan di Windows 64-bit.'
}
if ([Environment]::OSVersion.Version.Major -lt 10) {
    throw 'Mira butuh Windows 10 atau 11.'
}

$work = Join-Path $env:TEMP ('mira-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    # 1. Newest release. /releases/latest skips prereleases, so list instead.
    Say 'Mencari versi terbaru di GitHub...'
    try {
        $releases = Invoke-RestMethod -Uri "$Api/releases?per_page=10" -Headers (Get-Headers)
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 404 -or $code -eq 401) {
            throw 'Repositori Mira tidak bisa dibaca dari komputer ini (masih private). Minta installer ke admin, atau isi MIRA_GITHUB_TOKEN.'
        }
        throw "Gagal menghubungi GitHub: $($_.Exception.Message)"
    }
    $release = $releases | Where-Object { -not $_.draft } | Select-Object -First 1
    if (-not $release) { throw 'Belum ada rilis Mira di GitHub.' }

    $asset = $release.assets | Where-Object { $_.name -like 'Mira_*_x64-setup.exe' } | Select-Object -First 1
    if (-not $asset) { throw "Rilis $($release.tag_name) tidak punya installer Mira." }

    # 2. Expected checksum: GitHub's asset digest, or a .sha256 asset.
    $expected = $null
    if ($asset.digest -and $asset.digest -like 'sha256:*') {
        $expected = $asset.digest.Substring(7).ToLowerInvariant()
    } else {
        $shaAsset = $release.assets | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1
        if ($shaAsset) {
            $shaFile = Join-Path $work 'setup.sha256'
            if ($Token) {
                Invoke-WebRequest -Uri $shaAsset.url -Headers (Get-Headers 'application/octet-stream') -OutFile $shaFile -UseBasicParsing
            } else {
                Invoke-WebRequest -Uri $shaAsset.browser_download_url -OutFile $shaFile -UseBasicParsing
            }
            $expected = ((Get-Content -Path $shaFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
        }
    }
    if (-not $expected) { throw "Rilis $($release.tag_name) tidak punya checksum installer. Pemasangan dibatalkan." }

    $sizeMb = [math]::Round($asset.size / 1MB, 1)
    Say "Mengunduh Mira $($release.tag_name) ($sizeMb MB)..."
    $setup = Join-Path $work $asset.name
    if ($Token) {
        Invoke-WebRequest -Uri $asset.url -Headers (Get-Headers 'application/octet-stream') -OutFile $setup -UseBasicParsing
    } else {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing
    }
    $actual = (Get-FileHash -Path $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        throw 'Checksum file yang diunduh tidak cocok. Pemasangan dibatalkan.'
    }
    Say 'Checksum cocok.'
    Unblock-File -Path $setup

    if ($DryRun) {
        Say "Uji coba saja (MIRA_INSTALL_DRY_RUN=1): installer tidak dijalankan. File: $setup"
        return
    }

    # 3. Close a running Mira so the installer can replace mira.exe.
    $running = Get-Process -Name 'mira' -ErrorAction SilentlyContinue
    if ($running) {
        Say 'Menutup Mira yang sedang jalan...'
        $running | ForEach-Object { [void]$_.CloseMainWindow() }
        $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
        Get-Process -Name 'mira' -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 800
    }

    # 4. Silent per-user install. WebView2 is downloaded by the installer if missing.
    Say 'Memasang Mira...'
    $proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "Installer berhenti dengan kode $($proc.ExitCode)."
    }

    $exe = Find-MiraExe
    if (-not $exe) {
        Say 'Mira terpasang, tapi lokasinya tidak ditemukan. Buka Mira dari Start Menu.'
        return
    }
    Say "Terpasang di $(Split-Path $exe)"
    Say 'Membuka Mira. Saat pertama dibuka, izinkan Mira di Windows Firewall untuk jaringan kantor.'
    Start-Process -FilePath $exe
    Write-Host ''
    Write-Host "Selesai. Mira $($release.tag_name) siap dipakai."
} finally {
    if (-not $DryRun) {
        Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
