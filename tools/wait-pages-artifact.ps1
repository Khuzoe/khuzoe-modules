param(
    [Parameter(Mandatory=$true)][string]$Repository,
    [Parameter(Mandatory=$true)][string]$RunId,
    [Parameter(Mandatory=$true)][string]$ArtifactName,
    [ValidateRange(1,20)][int]$Attempts = 12,
    [ValidateRange(0,10)][int]$DelaySeconds = 5
)
$ErrorActionPreference = 'Stop'
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $response = & gh api "repos/$Repository/actions/runs/$RunId/artifacts?per_page=100"
    if ($LASTEXITCODE -eq 0) {
        $metadata = $response | ConvertFrom-Json
        $matching = @($metadata.artifacts | Where-Object { $_.name -eq $ArtifactName -and -not $_.expired })
        if ($matching.Count -eq 1) {
            Write-Output 'File del catalogo disponibile per la pubblicazione.'
            return
        }
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds $DelaySeconds }
}
throw "GitHub non ha reso disponibile un unico file del catalogo per il tentativo corrente: $ArtifactName"
