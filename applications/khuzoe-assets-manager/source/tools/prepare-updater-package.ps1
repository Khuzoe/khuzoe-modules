param([Parameter(Mandatory=$true)][string]$PublisherRoot)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$publisher = [IO.Path]::GetFullPath($PublisherRoot)
$config = Get-Content -LiteralPath (Join-Path $publisher 'publisher.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $root 'application.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = (Get-Content -LiteralPath (Join-Path $root 'app\version.txt') -Raw).Trim()
if ($manifest.id -ne 'khuzoe-assets-manager' -or $manifest.version -ne $version -or $version -notmatch '^\d+\.\d+\.\d+$' -or $config.repository -ne 'Khuzoe/khuzoe-modules') { throw 'Versione, applicazione o repository non validi.' }
$output = Join-Path $root ('build\release-' + $version)
& (Join-Path $PSScriptRoot 'build-app.ps1') -OutputDirectory $output
$exe = Join-Path $output 'KhuzoeAssetsManager.exe'
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileVersion -ne ($version + '.0')) { throw 'Versione eseguibile non corretta.' }
$stage = Join-Path $root ('build\runtime-' + [Guid]::NewGuid().ToString('N').Substring(0,12))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($name in @('KhuzoeAssetsManager.exe','KhuzoeAssetsManager.exe.config','scene-reader')) { Copy-Item -LiteralPath (Join-Path $output $name) -Destination (Join-Path $stage $name) -Recurse }
foreach ($name in @('README.md','THIRD_PARTY.md','VERIFICHE.md')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $stage $name) }
$tag = $manifest.id + '-v' + $version
$manifest | Add-Member -NotePropertyName url -NotePropertyValue ('https://github.com/' + $config.repository) -Force
$manifest | Add-Member -NotePropertyName manifest -NotePropertyValue ($config.pagesUrl + '/applications/' + $manifest.id + '/application.json') -Force
$manifest | Add-Member -NotePropertyName download -NotePropertyValue ('https://github.com/' + $config.repository + '/releases/download/' + $tag + '/application.zip') -Force
$manifestText = ($manifest | ConvertTo-Json -Depth 8) + "`n"
[IO.File]::WriteAllText((Join-Path $stage 'application.json'), $manifestText, [Text.UTF8Encoding]::new($false))
$target = [IO.Path]::GetFullPath((Join-Path $publisher ('applications\' + $manifest.id)))
if (-not $target.StartsWith($publisher + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Destinazione esterna al publisher.' }
for ($directory = $target; $directory.StartsWith($publisher,[StringComparison]::OrdinalIgnoreCase); $directory = [IO.Path]::GetDirectoryName($directory)) {
  if ((Test-Path -LiteralPath $directory) -and (((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Destinazione con collegamenti non consentita.' }
  if ($directory -eq $publisher) { break }
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
$zip = Join-Path $target 'application.zip'
Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $stage | Select-Object -ExpandProperty FullName) -DestinationPath $zip -CompressionLevel Optimal -Force
[IO.File]::WriteAllText((Join-Path $target 'application.json'), $manifestText, [Text.UTF8Encoding]::new($false))
$release = @{ id = $manifest.id; version = $version; sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $zip).Length }
[IO.File]::WriteAllText((Join-Path $target 'release.json'), ($release | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ('Pacchetto runtime pronto: ' + $zip)
Write-Output ('SHA256 ' + $release.sha256 + ' - ' + $release.size + ' byte')
