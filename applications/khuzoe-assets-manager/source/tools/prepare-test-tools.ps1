# Development-only helper for restricted test environments. The released app performs
# the same preparation itself; users do not need PowerShell or this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$liveRoot = Join-Path $projectRoot 'build\live'
$toolRoot = Join-Path $liveRoot 'tools'
$stage = Join-Path $liveRoot ('prepare-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$headers = @{ 'User-Agent' = 'KhuzoeAssetsManager-Development' }
function Get-OfficialAsset([string]$Repo, [string]$Name, [string]$Destination) {
    $release = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $Repo + '/releases/latest') -Headers $headers -TimeoutSec 40
    $asset = @($release.assets | Where-Object name -EQ $Name)
    if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Release senza impronta valida.' }
    $url = [Uri]$asset[0].browser_download_url
    if ($url.Scheme -ne 'https' -or $url.Host -ne 'github.com' -or -not $url.AbsolutePath.StartsWith('/' + $Repo + '/releases/download/')) { throw 'Fonte non valida.' }
    Write-Output ('Download ' + $Name)
    Invoke-WebRequest -Uri $url -Headers $headers -OutFile $Destination -TimeoutSec 600
    if ((Get-Item -LiteralPath $Destination).Length -ne $asset[0].size -or (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset[0].digest.Substring(7)) { throw 'Integrità non valida.' }
}
Get-OfficialAsset 'yt-dlp/yt-dlp' 'yt-dlp.exe' (Join-Path $stage 'yt-dlp.exe')
$archivePath = Join-Path $stage 'ffmpeg.zip'
Get-OfficialAsset 'yt-dlp/FFmpeg-Builds' 'ffmpeg-master-latest-win64-gpl.zip' $archivePath
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
        $entries = @($zip.Entries | Where-Object { $_.FullName.Replace('\','/').EndsWith('/bin/' + $name) })
        if ($entries.Count -ne 1) { throw 'Pacchetto FFmpeg inatteso.' }
        $source = $entries[0].Open()
        $target = [IO.File]::Create((Join-Path $stage $name))
        try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
    }
} finally { $zip.Dispose() }
Remove-Item -LiteralPath $archivePath
$checksums = (Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -Headers $headers -TimeoutSec 40).Content
$match = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+win-x64/node.exe\r?$')
if (-not $match.Success) { throw 'Impronta Node mancante.' }
$nodeFile = Join-Path $stage 'node.exe'
Write-Output 'Download node.exe'
Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/win-x64/node.exe' -Headers $headers -OutFile $nodeFile -TimeoutSec 180
if ((Get-FileHash -LiteralPath $nodeFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Integrità Node non valida.' }
$integrity = @{}
foreach ($name in @('yt-dlp.exe','ffmpeg.exe','ffprobe.exe','node.exe')) { $integrity[$name] = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText((Join-Path $stage 'integrity.json'), ($integrity | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $toolRoot) { throw 'La cartella degli strumenti esiste già: non verrà sostituita dal helper di test.' }
$resolvedStage = [IO.Path]::GetFullPath($stage)
$resolvedTools = [IO.Path]::GetFullPath($toolRoot)
$expectedRoot = [IO.Path]::GetFullPath($liveRoot) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedStage.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $resolvedTools.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Percorso di test non valido.' }
Move-Item -LiteralPath $resolvedStage -Destination $resolvedTools
Write-Output 'Componenti verificati pronti per le prove isolate.'
