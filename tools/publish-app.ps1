param([string]$OutputPath, [string]$Repository = $env:GITHUB_REPOSITORY)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $projectRoot 'dist' }
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'publisher.config.json') | ConvertFrom-Json
$version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'app\version.txt')).Trim()
if ($Repository -ne $config.repository -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Repository o versione app non validi.' }
$tag = "updater-v$version"
$manifestPath = Join-Path $outputRoot 'app-update.json'
& gh release view $tag --repo $Repository *> $null
if ($LASTEXITCODE -eq 0) {
    # Reuse the immutable manifest when a run is retried; recompilation changes executable bytes.
    & gh release download $tag --repo $Repository --pattern app-update.json --dir $outputRoot --clobber
    if ($LASTEXITCODE -ne 0) { throw 'La release esiste senza manifest app. Pubblica una nuova versione.' }
    Write-Output "La versione $version esiste già: mantengo i pacchetti pubblicati."
} else {
    & gh release list --repo $Repository --limit 1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Impossibile verificare le Releases GitHub.' }
    $exe = Join-Path $outputRoot 'KhuzoeUpdater.exe'
    $exeConfig = $exe + '.config'
    if ([Version]([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion) -ne [Version]("$version.0")) { throw 'La build non corrisponde alla versione da pubblicare.' }
    $zip = Join-Path $outputRoot 'KhuzoeUpdater-Windows.zip'
    Compress-Archive -LiteralPath $exe,$exeConfig -DestinationPath $zip -Force
    $manifest = [ordered]@{
        schemaVersion = 1
        repository = $Repository
        version = $version
        download = "https://github.com/$Repository/releases/download/$tag/KhuzoeUpdater-Windows.zip"
        size = (Get-Item -LiteralPath $zip).Length
        sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
        configSha256 = (Get-FileHash -LiteralPath $exeConfig -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    & gh release create $tag $zip $exe $exeConfig $manifestPath --repo $Repository --target $env:GITHUB_SHA --title "Khuzoe Updater $version" --notes 'Estrai lo ZIP e tieni insieme EXE e file .config. Dalla versione 0.4.0 gli aggiornamenti successivi si installano con Aggiorna app.' --latest=false
    if ($LASTEXITCODE -ne 0) { throw 'Pubblicazione app non riuscita.' }
}
$published = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($published.version -ne $version -or $published.repository -ne $Repository -or $published.schemaVersion -ne 1) { throw 'Manifest della release non valido.' }
# A separate channel avoids selecting a module release as the latest app version.
& gh release view updater-channel --repo $Repository *> $null
if ($LASTEXITCODE -ne 0) {
    & gh release create updater-channel --repo $Repository --target $env:GITHUB_SHA --title 'Canale aggiornamenti Khuzoe Updater' --notes 'Informazioni usate automaticamente da Khuzoe Updater. Per il download manuale usa una release updater-v.' --prerelease --latest=false
    if ($LASTEXITCODE -ne 0) { throw 'Creazione canale app non riuscita.' }
} else {
    $channelJson = & gh release view updater-channel --repo $Repository --json assets
    if ($LASTEXITCODE -ne 0) { throw 'Verifica canale app non riuscita.' }
    $channel = $channelJson | ConvertFrom-Json
    if (@($channel.assets | Where-Object { $_.name -eq 'app-update.json' }).Count -gt 0) {
        $channelDir = Join-Path $projectRoot ('build\channel-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $channelDir -Force | Out-Null
        & gh release download updater-channel --repo $Repository --pattern app-update.json --dir $channelDir
        if ($LASTEXITCODE -ne 0) { throw 'Lettura versione corrente del canale app non riuscita.' }
        $current = Get-Content -Raw -LiteralPath (Join-Path $channelDir 'app-update.json') | ConvertFrom-Json
        if ([Version]$current.version -gt [Version]$version) {
            Write-Output 'Il canale contiene già una versione più recente: viene conservata.'
            exit 0
        }
    }
}
& gh release upload updater-channel $manifestPath --repo $Repository --clobber
if ($LASTEXITCODE -ne 0) { throw 'Aggiornamento canale app non riuscito. È possibile ripetere il workflow.' }
Write-Output "Pubblicato canale app: $version"
