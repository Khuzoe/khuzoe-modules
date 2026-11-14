param([string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'app\version.txt')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versione non valida.' }
$binaries = if ([string]::IsNullOrWhiteSpace($BuildDirectory)) { Join-Path $root 'dist' } elseif ([IO.Path]::IsPathRooted($BuildDirectory)) { [IO.Path]::GetFullPath($BuildDirectory) } else { [IO.Path]::GetFullPath((Join-Path $root $BuildDirectory)) }
$exe = Join-Path $binaries 'KhuzoeAssetsManager.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Compila prima la versione dell'app." }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion -ne ($version + '.0')) { throw 'La build non corrisponde alla versione dei sorgenti.' }
$stage = Join-Path $root ('build\package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($name in @('KhuzoeAssetsManager.exe','KhuzoeAssetsManager.exe.config')) { Copy-Item -LiteralPath (Join-Path $binaries $name) -Destination (Join-Path $stage $name) }
foreach ($name in @('README.md','THIRD_PARTY.md','VERIFICHE.md','application.json')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $stage $name) }
if (-not (Test-Path -LiteralPath (Join-Path $binaries 'scene-reader\integrity.json'))) { throw 'Il runtime scene non è stato preparato.' }
Copy-Item -LiteralPath (Join-Path $binaries 'scene-reader') -Destination (Join-Path $stage 'scene-reader') -Recurse
$source = Join-Path $stage 'sorgenti'
New-Item -ItemType Directory -Path $source -Force | Out-Null
foreach ($folder in @('app','tests','tools')) {
    $destination = Join-Path $source $folder
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $root $folder) -File | Where-Object { $_.Extension -in @('.cs','.ps1','.txt','.config','.manifest','.ico') } | Copy-Item -Destination $destination
}
foreach ($name in @('README.md','THIRD_PARTY.md','VERIFICHE.md','AGENTS.md','.gitignore','application.json')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $source $name) }
$engineSource = Join-Path $source 'engine'
New-Item -ItemType Directory -Path $engineSource -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'engine') -File -Force | Where-Object { $_.Name -notlike '*.tmp' } | Copy-Item -Destination $engineSource
$zip = Join-Path $root ('dist\KhuzoeAssetsManager-' + $version + '-Windows.zip')
if (Test-Path -LiteralPath $zip) {
    $resolved = [IO.Path]::GetFullPath($zip)
    if (-not $resolved.StartsWith((Join-Path $root 'dist') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Percorso pacchetto non valido.' }
    Remove-Item -LiteralPath $resolved
}
Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $stage -Force | Select-Object -ExpandProperty FullName) -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $root 'dist\SHA256SUMS.txt'), ($hash + '  ' + [IO.Path]::GetFileName($zip) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output $zip
Write-Output ('SHA256 ' + $hash)
