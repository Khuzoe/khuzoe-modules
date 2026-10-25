param([switch]$Test)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Serve .NET Framework 4.8 per compilare Khuzoe Updater.' }
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'publisher.config.json') | ConvertFrom-Json
$version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'app\version.txt')).Trim()
$generatedRoot = Join-Path $projectRoot 'build'
New-Item -ItemType Directory -Path $generatedRoot -Force | Out-Null
$allowed = ($config.modules | ForEach-Object { '"' + $_ + '"' }) -join ', '
if ($config.pagesUrl -notmatch '^https://[a-zA-Z0-9./_-]+$' -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Configurazione di compilazione non valida.' }
$generated = @"
using System.Reflection;
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyProduct("Khuzoe Updater")]
namespace KhuzoeUpdater {
  internal static class BuildConfig {
    public const string Version = "$version";
    public const string CatalogUrl = "$($config.pagesUrl.TrimEnd('/'))/catalog.json";
    public static readonly string[] ModuleIds = new string[] { $allowed };
  }
}
"@
$generatedFile = Join-Path $generatedRoot 'BuildConfig.cs'
[IO.File]::WriteAllText($generatedFile, $generated, [Text.UTF8Encoding]::new($false))
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Management.dll')
$arguments = @('/nologo','/optimize+','/utf8output','/warnaserror+') + @($references | ForEach-Object { '/reference:' + $_ })
$sources = @((Join-Path $projectRoot 'app\Core.cs'), $generatedFile)
if ($Test) {
    $exe = Join-Path $outputRoot 'KhuzoeUpdater.Tests.exe'
    & $compiler @arguments '/target:exe' "/out:$exe" @sources (Join-Path $projectRoot 'tests\CoreTests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Compilazione test non riuscita.' }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw 'Test non riusciti.' }
} else {
    $exe = Join-Path $outputRoot 'KhuzoeUpdater.exe'
    & $compiler @arguments '/target:winexe' "/out:$exe" "/win32manifest:$(Join-Path $projectRoot 'app\app.manifest')" @sources (Join-Path $projectRoot 'app\MainForm.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Compilazione app non riuscita.' }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'app\KhuzoeUpdater.exe.config') -Destination ($exe + '.config') -Force
    Write-Output "App compilata: $exe"
}
