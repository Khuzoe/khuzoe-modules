param([switch]$Test, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$root = [IO.Path]::GetFullPath($root)
$out = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $root 'dist' } elseif ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory)) }
if (-not $out.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'La build deve restare dentro il progetto.' }
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Path $out,$build -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Serve il compilatore .NET Framework incluso in Windows.' }
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'app\version.txt')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versione non valida.' }
$assembly = Join-Path $build 'AssemblyInfo.cs'
[IO.File]::WriteAllText($assembly, @"
using System.Reflection;
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyProduct("Khuzoe Assets Manager")]
namespace KhuzoeAssetsManager { internal static class BuildConfig { public const string Version = "$version"; } }
"@, [Text.UTF8Encoding]::new($false))
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Security.dll')
$arguments = @('/nologo','/optimize+','/utf8output','/warnaserror+','/langversion:5') + @($references | ForEach-Object { '/reference:' + $_ })
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'app') -Filter '*.cs' -File | Select-Object -ExpandProperty FullName) + @($assembly)
& (Join-Path $PSScriptRoot 'build-scene-reader.ps1') -OutputDirectory $out
if ($Test) {
  $testSources = @(Get-ChildItem -LiteralPath (Join-Path $root 'tests') -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
  $testExe = Join-Path $out 'KhuzoeAssetsManager.Tests.exe'
  & $compiler @arguments '/target:exe' "/out:$testExe" '/main:KhuzoeAssetsManager.Tests' @sources @testSources
  if ($LASTEXITCODE -ne 0) { throw 'Compilazione test non riuscita.' }
  Copy-Item -LiteralPath (Join-Path $root 'app\KhuzoeAssetsManager.exe.config') -Destination ($testExe + '.config') -Force
  $previewExe = Join-Path $out 'KhuzoeAssetsManager.UiPreview.exe'
  & $compiler @arguments '/target:winexe' "/out:$previewExe" '/main:KhuzoeAssetsManager.UiPreview' ('/win32manifest:' + (Join-Path $root 'app\app.manifest')) @sources @testSources
  if ($LASTEXITCODE -ne 0) { throw 'Compilazione anteprima di test non riuscita.' }
  Copy-Item -LiteralPath (Join-Path $root 'app\KhuzoeAssetsManager.exe.config') -Destination ($previewExe + '.config') -Force
  & $testExe
  if ($LASTEXITCODE -ne 0) { throw 'Test non riusciti.' }
} else {
  $exe = Join-Path $out 'KhuzoeAssetsManager.exe'
  & $compiler @arguments '/target:winexe' "/out:$exe" ('/win32manifest:' + (Join-Path $root 'app\app.manifest')) @sources
  if ($LASTEXITCODE -ne 0) { throw 'Compilazione app non riuscita.' }
  Copy-Item -LiteralPath (Join-Path $root 'app\KhuzoeAssetsManager.exe.config') -Destination ($exe + '.config') -Force
  Write-Output "App compilata: $exe"
}
