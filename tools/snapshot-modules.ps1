param(
    [Parameter(Mandatory=$true)][string]$ModulesPath,
    [string[]]$ModuleId
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'publisher.config.json') | ConvertFrom-Json
$sourceRoot = [IO.Path]::GetFullPath($ModulesPath)
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'modules'))
if ($sourceRoot.TrimEnd('\') -eq $targetRoot.TrimEnd('\')) { throw 'Sorgente e destinazione coincidono.' }
if (-not $ModuleId) { $ModuleId = $config.modules }
foreach ($id in $ModuleId) {
    if ($id -notin $config.modules) { throw "Modulo non autorizzato: $id" }
    $source = Join-Path $sourceRoot $id
    $target = Join-Path $targetRoot $id
    if (Test-Path -LiteralPath $target) { throw "La copia $id esiste già. Nessuna sovrascrittura automatica: modifica la copia del progetto o prepara una nuova cartella di esportazione." }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $source 'module.json') | ConvertFrom-Json
    if ($manifest.id -ne $id) { throw "Manifest non corrispondente: $id" }
    $roots = @('module.json','scripts','styles','templates','lang','assets','icons','images','fonts','lib','tests','tools','packData','package.json','package-lock.json','README.md','CHANGELOG.md','LICENSE','LICENSE.md','LICENSE.txt','THIRD_PARTY_NOTICES.md')
    $roots += @($manifest.scripts)
    $roots += @($manifest.esmodules)
    $roots += @($manifest.packs | ForEach-Object { $_.path })
    New-Item -ItemType Directory -Path $target | Out-Null
    foreach ($relative in ($roots | Where-Object { $_ } | Sort-Object -Unique)) {
        $full = [IO.Path]::GetFullPath((Join-Path $source $relative))
        if (-not $full.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Percorso fuori sorgente.' }
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $item = Get-Item -LiteralPath $full
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Collegamento non supportato: $full" }
        $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $full -Recurse -File) } else { @($item) }
        foreach ($file in $files) {
            if ($file.FullName -match '\\(node_modules|\.git|\.maintenance|dist)\\' -or $file.Name -in @('LOCK','LOG','LOG.old')) { continue }
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Collegamento non supportato: $($file.FullName)" }
            $destination = Join-Path $target $file.FullName.Substring($source.Length + 1)
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination
        }
    }
    Write-Output "Copiato senza modificare l'originale: $id $($manifest.version)"
}
