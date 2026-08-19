<#
.SYNOPSIS
    Installe les outils d'agents de code IA sur un poste Windows.

.DESCRIPTION
    Installe et verifie les CLI suivants :

      - graphify  (@sentropic/graphify)  : transforme un dossier en graphe de connaissances interrogeable
      - omniroute (omniroute)            : routeur IA unifie, 160+ fournisseurs, API compatible OpenAI
      - observer  (@superbased/observer) : suivi des tokens, couts et fichiers des agents de code
      - herdr                            : gestionnaire d'espaces de travail terminal (Linux/macOS seulement)

    herdr n'a PAS de version Windows native. Le script le detecte et, avec -IncludeHerdr,
    l'installe dans WSL2 s'il est disponible.

.PARAMETER Tools
    Sous-ensemble a installer : graphify, omniroute, observer. Par defaut : les trois.

.PARAMETER IncludeHerdr
    Tente d'installer herdr dans WSL2 (telecharge et execute https://herdr.dev/install.sh
    a l'interieur de la distribution WSL par defaut).

.PARAMETER WhatIfOnly
    Affiche les verifications et les commandes sans rien installer.

.EXAMPLE
    .\install-agent-tools.ps1

.EXAMPLE
    .\install-agent-tools.ps1 -Tools observer -IncludeHerdr

.NOTES
    Aucun droit administrateur requis pour les installations npm globales, sauf si npm
    a ete configure avec un prefixe dans Program Files.
#>

[CmdletBinding()]
param(
    [ValidateSet('graphify', 'omniroute', 'observer')]
    [string[]]$Tools = @('graphify', 'omniroute', 'observer'),

    [switch]$IncludeHerdr,

    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$script:Results = [System.Collections.Generic.List[object]]::new()

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail
    )
    $script:Results.Add([pscustomobject]@{
        Outil  = $Name
        Statut = $Status
        Detail = $Detail
    })
}

function Get-CommandVersion {
    param([string]$Command)
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return $null }
    try {
        $output = & $Command --version 2>&1 | Select-Object -First 1
        return ($output | Out-String).Trim()
    }
    catch {
        return 'installe (version illisible)'
    }
}

# ---------------------------------------------------------------------------
# Prerequis
# ---------------------------------------------------------------------------

Write-Section 'Verification des prerequis'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Node.js est introuvable dans le PATH." -ForegroundColor Red
    Write-Host "Installe-le d'abord : https://nodejs.org/ (version 22.22.2+ recommandee)."
    exit 1
}

$nodeRaw = (& node --version).Trim()          # ex. v22.22.2
$nodeVersion = [version]($nodeRaw.TrimStart('v') -replace '-.*$', '')
Write-Host "Node.js   : $nodeRaw"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host "npm est introuvable dans le PATH." -ForegroundColor Red
    exit 1
}
Write-Host "npm       : $((& npm --version).Trim())"
Write-Host "Prefixe   : $((& npm prefix -g).Trim())"

# omniroute impose engines: >=22.22.2 <23 || >=24.0.0 <27
$omnirouteNodeOk = ($nodeVersion -ge [version]'22.22.2' -and $nodeVersion -lt [version]'23.0.0') -or
                   ($nodeVersion -ge [version]'24.0.0'  -and $nodeVersion -lt [version]'27.0.0')

# graphify impose engines: >=20
$graphifyNodeOk = $nodeVersion -ge [version]'20.0.0'

if (-not $graphifyNodeOk) {
    Write-Host "Attention : graphify exige Node >= 20." -ForegroundColor Yellow
}
if (-not $omnirouteNodeOk) {
    Write-Host "Attention : omniroute exige Node >=22.22.2 <23 ou >=24 <27. La version actuelle ($nodeRaw) ne correspond pas." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Definition des paquets
# ---------------------------------------------------------------------------

$packages = @(
    [pscustomobject]@{
        Key         = 'graphify'
        Package     = '@sentropic/graphify'
        Command     = 'graphify'
        Description = 'Graphe de connaissances pour agents de code'
        NodeOk      = $graphifyNodeOk
        NodeReq     = 'Node >= 20'
    }
    [pscustomobject]@{
        Key         = 'omniroute'
        Package     = 'omniroute'
        Command     = 'omniroute'
        Description = 'Routeur IA unifie (160+ fournisseurs)'
        NodeOk      = $omnirouteNodeOk
        NodeReq     = 'Node >=22.22.2 <23 ou >=24 <27'
    }
    [pscustomobject]@{
        Key         = 'observer'
        Package     = '@superbased/observer'
        Command     = 'observer'
        Description = 'Observabilite des agents (tokens, couts, fichiers)'
        NodeOk      = $true
        NodeReq     = 'aucune contrainte declaree'
    }
)

# ---------------------------------------------------------------------------
# Installation npm
# ---------------------------------------------------------------------------

foreach ($pkg in $packages | Where-Object { $Tools -contains $_.Key }) {

    Write-Section "$($pkg.Key) - $($pkg.Description)"

    if (-not $pkg.NodeOk) {
        Write-Host "Ignore : version de Node incompatible ($($pkg.NodeReq))." -ForegroundColor Yellow
        Add-Result $pkg.Key 'IGNORE' "Node incompatible - requis : $($pkg.NodeReq)"
        continue
    }

    $existing = Get-CommandVersion $pkg.Command
    if ($existing) {
        Write-Host "Deja present (version $existing) - mise a jour vers la derniere version."
    }

    Write-Host "npm install -g $($pkg.Package)"

    if ($WhatIfOnly) {
        Add-Result $pkg.Key 'SIMULE' 'WhatIfOnly - aucune installation'
        continue
    }

    try {
        & npm install -g $pkg.Package
        if ($LASTEXITCODE -ne 0) { throw "npm a retourne le code $LASTEXITCODE" }
    }
    catch {
        Write-Host "Echec : $($_.Exception.Message)" -ForegroundColor Red
        Add-Result $pkg.Key 'ECHEC' $_.Exception.Message
        continue
    }

    # Le PATH du process courant peut ne pas voir le nouveau binaire : on recharge
    # depuis le registre. On ne remplace le PATH que si la lecture a reellement
    # donne quelque chose, pour ne jamais l'ecraser par une valeur vide.
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $refreshed   = @($machinePath, $userPath) | Where-Object { $_ }
    if ($refreshed) {
        $env:Path = ($refreshed -join ';')
    }

    $version = Get-CommandVersion $pkg.Command
    if ($version) {
        Write-Host "OK - $($pkg.Command) $version" -ForegroundColor Green
        Add-Result $pkg.Key 'INSTALLE' $version
    }
    else {
        Write-Host "Installe, mais '$($pkg.Command)' n'est pas dans le PATH de cette session." -ForegroundColor Yellow
        Add-Result $pkg.Key 'INSTALLE' "Rouvrir le terminal pour rafraichir le PATH"
    }
}

# ---------------------------------------------------------------------------
# herdr (Linux / macOS uniquement -> WSL2)
# ---------------------------------------------------------------------------

Write-Section 'herdr'

Write-Host "herdr ne fournit pas de binaire Windows (README officiel : 'requirements: linux or macos')."
Write-Host "La detection d'etat des agents lit /proc, ce qui n'existe pas sous Windows."

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue

if (-not $wsl) {
    Write-Host "WSL2 n'est pas installe. Pour l'ajouter : wsl --install" -ForegroundColor Yellow
    Add-Result 'herdr' 'NON APPLICABLE' 'Pas de support Windows natif ; WSL2 absent'
}
elseif (-not $IncludeHerdr) {
    Write-Host "WSL2 detecte. Relance avec -IncludeHerdr pour installer herdr dedans." -ForegroundColor Yellow
    Add-Result 'herdr' 'IGNORE' 'WSL2 present - relancer avec -IncludeHerdr'
}
elseif ($WhatIfOnly) {
    Write-Host "wsl.exe -- bash -lc 'curl -fsSL https://herdr.dev/install.sh | sh'"
    Add-Result 'herdr' 'SIMULE' 'WhatIfOnly - aucune installation'
}
else {
    Write-Host "Installation de herdr dans la distribution WSL par defaut..."
    Write-Host "(telecharge et execute https://herdr.dev/install.sh)"
    try {
        & wsl.exe -- bash -lc 'curl -fsSL https://herdr.dev/install.sh | sh'
        if ($LASTEXITCODE -ne 0) { throw "wsl a retourne le code $LASTEXITCODE" }

        $herdrVersion = (& wsl.exe -- bash -lc 'herdr --version' 2>&1 | Out-String).Trim()
        Write-Host "OK - $herdrVersion" -ForegroundColor Green
        Add-Result 'herdr' 'INSTALLE (WSL)' $herdrVersion
    }
    catch {
        Write-Host "Echec : $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Alternative dans WSL : cargo install herdr (necessite rustup)."
        Add-Result 'herdr' 'ECHEC' $_.Exception.Message
    }
}

# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------

Write-Section 'Resume'

# Rendu manuel plutot que Format-Table : ce dernier n'affiche rien quand la
# console n'a pas de largeur (sortie redirigee, tache planifiee, CI).
if ($script:Results.Count -eq 0) {
    Write-Host 'Aucune action effectuee.'
}
else {
    $wOutil  = ($script:Results.Outil  | Measure-Object -Property Length -Maximum).Maximum
    $wStatut = ($script:Results.Statut | Measure-Object -Property Length -Maximum).Maximum
    $wOutil  = [Math]::Max($wOutil, 5)
    $wStatut = [Math]::Max($wStatut, 6)

    Write-Host ("{0}  {1}  {2}" -f 'Outil'.PadRight($wOutil), 'Statut'.PadRight($wStatut), 'Detail')
    Write-Host ("{0}  {1}  {2}" -f ('-' * $wOutil), ('-' * $wStatut), ('-' * 20))

    foreach ($r in $script:Results) {
        $color = switch ($r.Statut) {
            'ECHEC'   { 'Red' }
            'IGNORE'  { 'Yellow' }
            default   { if ($r.Statut -like 'INSTALLE*') { 'Green' } else { 'Gray' } }
        }
        Write-Host ("{0}  {1}  {2}" -f $r.Outil.PadRight($wOutil), $r.Statut.PadRight($wStatut), $r.Detail) -ForegroundColor $color
    }
}

$failed = $script:Results | Where-Object { $_.Statut -eq 'ECHEC' }
if ($failed) {
    Write-Host "$($failed.Count) installation(s) en echec." -ForegroundColor Red
    exit 1
}

Write-Host 'Termine.' -ForegroundColor Green
Write-Host "Si une commande reste introuvable, ferme et rouvre le terminal pour recharger le PATH."
