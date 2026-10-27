param([string]$BuildPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $BuildPath) { $BuildPath = Join-Path $projectRoot 'dist' }
$testRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.work\publish-app-' + [Guid]::NewGuid().ToString('N'))))
$workRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.work'))
if (-not $testRoot.StartsWith($workRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture fuori progetto.' }
$out = Join-Path $testRoot 'output'
$saved = Join-Path $testRoot 'published'
$channelDir = Join-Path $testRoot 'channel'
New-Item -ItemType Directory -Path $out,$saved,$channelDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $BuildPath 'KhuzoeUpdater.exe'),(Join-Path $BuildPath 'KhuzoeUpdater.exe.config') -Destination $out
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\version.txt') -Raw).Trim()
$global:KhuzoePublishTestState = @{ releaseExists = $false; channelExists = $false; creates = 0; uploads = 0; failUpload = $false; saved = $saved; channelDir = $channelDir }
# This shadows gh only inside this test process. No command reaches GitHub.
function global:gh {
    $state = $global:KhuzoePublishTestState
    $command = @($args)
    $global:LASTEXITCODE = 0
    if ($command[0] -ne 'release') { throw 'Comando GitHub inatteso.' }
    $operation = $command[1]; $tag = $command[2]
    switch ($operation) {
        'view' {
            $exists = if ($tag -eq 'updater-channel') { $state.channelExists } else { $state.releaseExists }
            if (-not $exists) { $global:LASTEXITCODE = 1; return }
            if ($command -contains '--json') {
                $assets = if (Test-Path -LiteralPath (Join-Path $state.channelDir 'app-update.json')) { @(@{ name = 'app-update.json' }) } else { @() }
                return (@{ assets = $assets } | ConvertTo-Json -Depth 5 -Compress)
            }
        }
        'list' { return }
        'create' {
            if ($tag -eq 'updater-channel') { $state.channelExists = $true; return }
            if ($tag -notmatch '^updater-v\d+\.\d+\.\d+$') { throw 'Tentativo di pubblicare una release diversa da quella app.' }
            foreach ($candidate in $command[3..6]) { Copy-Item -LiteralPath $candidate -Destination $state.saved -Force }
            $state.releaseExists = $true; $state.creates++
        }
        'download' {
            $destination = $command[[Array]::IndexOf($command, '--dir') + 1]
            $source = if ($tag -eq 'updater-channel') { $state.channelDir } else { $state.saved }
            Copy-Item -LiteralPath (Join-Path $source 'app-update.json') -Destination $destination -Force
        }
        'upload' {
            if ($tag -ne 'updater-channel') { throw 'Asset di una release immutabile sovrascritto.' }
            if ($state.failUpload) { $global:LASTEXITCODE = 1; return }
            Copy-Item -LiteralPath $command[3] -Destination $state.channelDir -Force; $state.uploads++
        }
        default { throw "Operazione GitHub inattesa: $operation" }
    }
}
try {
    $publisher = Join-Path $projectRoot 'tools\publish-app.ps1'
    $repository = (Get-Content -LiteralPath (Join-Path $projectRoot 'publisher.config.json') -Raw | ConvertFrom-Json).repository
    & $publisher -OutputPath $out -Repository $repository
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $saved 'app-update.json') | ConvertFrom-Json
    if ($manifest.version -ne $version -or $manifest.repository -ne $repository -or $manifest.sha256 -ne (Get-FileHash -LiteralPath (Join-Path $saved 'KhuzoeUpdater-Windows.zip')).Hash.ToLowerInvariant() -or $manifest.exeSha256 -ne (Get-FileHash -LiteralPath (Join-Path $saved 'KhuzoeUpdater.exe')).Hash.ToLowerInvariant()) { throw 'Manifest pubblicato diverso dai pacchetti.' }
    Write-Output 'OK pubblicazione iniziale: ZIP, impronte, release e canale separato.'
    $immutable = Get-Content -Raw -LiteralPath (Join-Path $saved 'app-update.json')
    [IO.File]::AppendAllText((Join-Path $out 'KhuzoeUpdater.exe'), 'different-rebuild')
    & $publisher -OutputPath $out -Repository $repository
    if ($global:KhuzoePublishTestState.creates -ne 1 -or (Get-Content -Raw -LiteralPath (Join-Path $channelDir 'app-update.json')) -ne $immutable) { throw 'Il secondo tentativo modifica la release originale.' }
    Write-Output 'OK nuovo tentativo: riusa i pacchetti pubblicati senza sovrascriverli.'
    $manifest.version = '99.0.0'
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $channelDir 'app-update.json') -Encoding utf8
    $before = $global:KhuzoePublishTestState.uploads
    & $publisher -OutputPath $out -Repository $repository
    if ($global:KhuzoePublishTestState.uploads -ne $before) { throw 'Canale riportato a versione precedente.' }
    Write-Output 'OK versione più recente del canale conservata.'
    [IO.File]::WriteAllText((Join-Path $channelDir 'app-update.json'), $immutable, [Text.UTF8Encoding]::new($false))
    $global:KhuzoePublishTestState.failUpload = $true
    $failed = $false
    try { & $publisher -OutputPath $out -Repository $repository } catch { $failed = $true }
    if (-not $failed) { throw 'Errore caricamento non segnalato.' }
    $global:KhuzoePublishTestState.failUpload = $false
    & $publisher -OutputPath $out -Repository $repository
    if ($global:KhuzoePublishTestState.creates -ne 1 -or $global:KhuzoePublishTestState.uploads -ne ($before + 1)) { throw 'Nuovo tentativo dopo interruzione non riuscito.' }
    Write-Output 'OK caricamento interrotto ripetibile senza nuova release.'
} finally {
    Remove-Item Function:\gh
    Remove-Variable KhuzoePublishTestState -Scope Global
    if ($testRoot.StartsWith($workRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
