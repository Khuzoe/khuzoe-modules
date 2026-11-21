$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$probe = Join-Path $projectRoot 'tools\wait-pages-artifact.ps1'
$artifact = 'github-pages-123-2'
$global:KhuzoePagesProbeState = @{ calls = 0; replies = @() }
function global:gh {
    $state = $global:KhuzoePagesProbeState
    if ($args[0] -ne 'api' -or $args[1] -ne 'repos/Khuzoe/khuzoe-modules/actions/runs/123/artifacts?per_page=100') {
        throw 'Richiesta inattesa nella prova del catalogo.'
    }
    $reply = $state.replies[$state.calls]
    $state.calls++
    $global:LASTEXITCODE = if ($reply.failure) { 1 } else { 0 }
    return ($reply | ConvertTo-Json -Depth 5 -Compress)
}
try {
    $global:KhuzoePagesProbeState.replies = @(
        @{ artifacts = @() },
        @{ artifacts = @(@{ name = 'github-pages-123-1'; expired = $false }, @{ name = $artifact; expired = $true }) },
        @{ artifacts = @(@{ name = 'github-pages-123-1'; expired = $false }, @{ name = $artifact; expired = $false }) }
    )
    & $probe -Repository 'Khuzoe/khuzoe-modules' -RunId '123' -ArtifactName $artifact -Attempts 3 -DelaySeconds 0
    if ($global:KhuzoePagesProbeState.calls -ne 3) { throw 'Il file del tentativo precedente è stato accettato.' }
    Write-Output 'OK attende il file corrente, anche con file precedenti o scaduti presenti.'
    $global:KhuzoePagesProbeState.calls = 0
    $global:KhuzoePagesProbeState.replies = @(
        @{ artifacts = @(@{ name = 'github-pages-123-1'; expired = $false }) },
        @{ artifacts = @(@{ name = 'github-pages-123-1'; expired = $false }) }
    )
    $rejected = $false
    try { & $probe -Repository 'Khuzoe/khuzoe-modules' -RunId '123' -ArtifactName $artifact -Attempts 2 -DelaySeconds 0 } catch { $rejected = $true }
    if (-not $rejected -or $global:KhuzoePagesProbeState.calls -ne 2) { throw 'File corrente mancante non rifiutato.' }
    Write-Output 'OK interrompe la pubblicazione se esiste soltanto un file precedente.'
    $global:KhuzoePagesProbeState.calls = 0
    $global:KhuzoePagesProbeState.replies = @(
        @{ failure = $true },
        @{ artifacts = @(@{ name = $artifact; expired = $false }) }
    )
    & $probe -Repository 'Khuzoe/khuzoe-modules' -RunId '123' -ArtifactName $artifact -Attempts 2 -DelaySeconds 0
    if ($global:KhuzoePagesProbeState.calls -ne 2) { throw 'Errore temporaneo GitHub non recuperato.' }
    Write-Output 'OK recupera un errore temporaneo del servizio GitHub.'
} finally {
    Remove-Item Function:\gh
    Remove-Variable KhuzoePagesProbeState -Scope Global
}
