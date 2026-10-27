param([switch]$Test, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $projectRoot 'dist' }
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Serve .NET Framework 4.8 per compilare Khuzoe Updater.' }
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'publisher.config.json') | ConvertFrom-Json
$version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'app\version.txt')).Trim()
$generatedRoot = Join-Path $projectRoot 'build'
New-Item -ItemType Directory -Path $generatedRoot -Force | Out-Null
$allowed = ($config.modules | ForEach-Object { '"' + $_ + '"' }) -join ', '
if ($config.pagesUrl -notmatch '^https://[a-zA-Z0-9./_-]+$' -or $config.repository -notmatch '^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$' -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Configurazione di compilazione non valida.' }
$generated = @"
using System.Reflection;
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyProduct("Khuzoe Updater")]
namespace KhuzoeUpdater {
  internal static class BuildConfig {
    public const string Version = "$version";
    public const string Repository = "$($config.repository)";
    public const string CatalogUrl = "$($config.pagesUrl.TrimEnd('/'))/catalog.json";
    public static readonly string[] ModuleIds = new string[] { $allowed };
  }
}
"@
$generatedFile = Join-Path $generatedRoot 'BuildConfig.cs'
[IO.File]::WriteAllText($generatedFile, $generated, [Text.UTF8Encoding]::new($false))
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Management.dll')
$arguments = @('/nologo','/optimize+','/utf8output','/warnaserror+') + @($references | ForEach-Object { '/reference:' + $_ })
$sources = @((Join-Path $projectRoot 'app\Core.cs'), (Join-Path $projectRoot 'app\AppUpdates.cs'), $generatedFile)
if ($Test) {
    $fixtureRoot = Join-Path $generatedRoot 'app-update-fixtures'
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    foreach ($fixtureName in @('old', 'new')) {
        $fixtureVersion = if ($fixtureName -eq 'old') { '0.0.1.0' } else { '0.0.2.0' }
        $fixtureAssembly = Join-Path $fixtureRoot ($fixtureName + '-version.cs')
        [IO.File]::WriteAllText($fixtureAssembly, ('[assembly: System.Reflection.AssemblyFileVersion("' + $fixtureVersion + '")]'), [Text.UTF8Encoding]::new($false))
        & $compiler '/nologo' '/target:winexe' ('/out:' + (Join-Path $fixtureRoot ($fixtureName + '.exe'))) $fixtureAssembly (Join-Path $projectRoot 'tests\AppUpdateFixture.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Compilazione fixture aggiornamento app non riuscita.' }
        Copy-Item -LiteralPath (Join-Path $projectRoot 'app\KhuzoeUpdater.exe.config') -Destination (Join-Path $fixtureRoot ($fixtureName + '.config')) -Force
    }
    & $compiler @arguments '/target:winexe' ('/out:' + (Join-Path $fixtureRoot 'helper-host.exe')) @sources (Join-Path $projectRoot 'app\MainForm.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Compilazione supporto di prova non riuscita.' }
    $exe = Join-Path $outputRoot 'KhuzoeUpdater.Tests.exe'
    & $compiler @arguments '/target:exe' "/out:$exe" @sources (Join-Path $projectRoot 'tests\CoreTests.cs') (Join-Path $projectRoot 'tests\AppUpdateTests.cs')
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
