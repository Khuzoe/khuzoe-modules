param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$engine = Join-Path $root 'engine'
$modules = Join-Path $engine 'node_modules'
if (-not (Test-Path -LiteralPath (Join-Path $modules 'classic-level\package.json'))) { throw 'Prepara il lettore con npm ci --ignore-scripts nella cartella engine.' }
$out = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $root 'dist' } elseif ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory)) }
if (-not $out.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Il runtime deve restare dentro il progetto.' }
$target = Join-Path $out 'scene-reader'
$resolvedTarget = [IO.Path]::GetFullPath($target)
if (-not $resolvedTarget.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedTarget) -ne 'scene-reader') { throw 'Percorso runtime non valido.' }
for ($directory = [IO.Path]::GetDirectoryName($resolvedTarget); $directory.StartsWith($root, [StringComparison]::OrdinalIgnoreCase); $directory = [IO.Path]::GetDirectoryName($directory)) {
  if ((Test-Path -LiteralPath $directory) -and (((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Il percorso runtime non può contenere collegamenti.' }
  if ($directory -eq $root) { break }
}
if (Test-Path -LiteralPath $resolvedTarget) {
  if (((Get-Item -LiteralPath $resolvedTarget).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Il runtime non può essere un collegamento.' }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $engine 'reader.cjs'),(Join-Path $engine 'package.json'),(Join-Path $engine 'package-lock.json') -Destination $resolvedTarget
Get-ChildItem -LiteralPath $modules -Recurse -File -Force | ForEach-Object {
  $relative = $_.FullName.Substring($modules.Length + 1).Replace('\','/')
  if ($relative -like '.bin/*') { return }
  $notice = $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)([.-]|$)'
  # Windows uses the official win32-x64 prebuild; retain license notices from omitted native sources.
  if ($relative -like 'classic-level/deps/*' -and -not $notice) { return }
  if ($relative -like 'classic-level/prebuilds/*' -and $relative -notlike 'classic-level/prebuilds/win32-x64/*') { return }
  if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Una dipendenza runtime è un collegamento.' }
  $destination = Join-Path (Join-Path $resolvedTarget 'node_modules') $relative.Replace('/',[IO.Path]::DirectorySeparatorChar)
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination
}
$integrity = @{}
Get-ChildItem -LiteralPath $resolvedTarget -Recurse -File -Force | ForEach-Object {
  $relative = $_.FullName.Substring($resolvedTarget.Length + 1).Replace('\','/')
  $integrity[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText((Join-Path $resolvedTarget 'integrity.json'), ($integrity | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output ('Lettore scene preparato: ' + $integrity.Count + ' file verificabili.')
