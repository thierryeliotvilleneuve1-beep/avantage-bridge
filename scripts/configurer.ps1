<#
.SYNOPSIS
  Ecrit le .env de l'Adjointe IA en posant les questions, puis propose de demarrer.

.DESCRIPTION
  Script sans accents (Windows PowerShell 5.1 lit les .ps1 en ANSI).
  Aucun secret ne s'affiche a l'ecran : la saisie est masquee et seule la
  longueur est confirmee. Le fichier est ecrit en UTF-8 sans BOM, dans le
  dossier du depot - jamais ailleurs.

.EXAMPLE
  .\scripts\configurer.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$racine = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $racine '.env'

# Valeurs etablies le 3 septembre 2026 lors de l'inscription Entra ID.
$DEFAUTS = [ordered]@{
  PORT                 = '3001'
  API_KEY              = ''          # genere si vide
  CRON_SCHEDULE        = 'off'
  GRAPH_TENANT_ID      = 'd6b762e1-e392-442a-904b-ecff6968612f'
  GRAPH_CLIENT_ID      = 'fbb53e8d-1cac-4db5-9814-47ff186f5729'
  GRAPH_CLIENT_SECRET  = ''
  ANTHROPIC_API_KEY    = ''
  ADJOINTE_MAILBOX     = 'projets@c-rc.ca'
  ADJOINTE_NIVEAU      = '0'
  ADJOINTE_CRON        = ''
  ADJOINTE_CP_EMAIL    = 'c.milot@c-rc.ca'
  ADJOINTE_ADRESSES_HERITEES = ''
  ADJOINTE_MODELE      = 'claude-opus-5'
  VAULT_DIR            = ''
}

function LireExistant {
  if (-not (Test-Path $envPath)) { return @{} }
  $h = @{}
  foreach ($l in Get-Content $envPath) {
    if ($l -match '^\s*([A-Z_]+)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() }
  }
  return $h
}

function LireSecret($invite, $actuel) {
  if ($actuel -and $actuel -ne 'CHANGE_MOI_CLE_SECRETE_LONGUE') {
    Write-Host "    deja present ($($actuel.Length) caracteres)" -ForegroundColor Green
    if ((Read-Host '    Le remplacer ? (o/N)') -notin @('o','O')) { return $actuel }
  }
  while ($true) {
    $sec = Read-Host "    $invite (saisie masquee)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try   { $val = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ([string]::IsNullOrWhiteSpace($val)) {
      Write-Host '    Valeur vide - recommence.' -ForegroundColor Yellow
    } else {
      Write-Host "    Recu : $($val.Length) caracteres" -ForegroundColor Green
      return $val
    }
  }
}

Write-Host "`n=== Adjointe IA - configuration ===" -ForegroundColor Cyan
Write-Host "Fichier ecrit : $envPath"
Write-Host 'Rien de ce que tu saisis ne s affiche a l ecran.' -ForegroundColor Yellow

$actuel = LireExistant
$valeurs = [ordered]@{}
foreach ($cle in $DEFAUTS.Keys) { $valeurs[$cle] = if ($actuel.ContainsKey($cle)) { $actuel[$cle] } else { $DEFAUTS[$cle] } }
foreach ($cle in @('PORT','CRON_SCHEDULE','GRAPH_TENANT_ID','GRAPH_CLIENT_ID','ADJOINTE_MAILBOX','ADJOINTE_NIVEAU')) {
  if ([string]::IsNullOrWhiteSpace($valeurs[$cle])) { $valeurs[$cle] = $DEFAUTS[$cle] }
}
# Un .env herite de l'exemple porte des valeurs a ne pas conserver.
if ($valeurs['CRON_SCHEDULE'] -ne 'off') { $valeurs['CRON_SCHEDULE'] = 'off' }
if ($valeurs['PORT'] -eq '3000') { $valeurs['PORT'] = '3001' }

Write-Host "`n[1] Secret client Entra ID" -ForegroundColor Cyan
Write-Host '    Portail Entra > Inscriptions d applications > CRC - Adjointe IA > Certificats et secrets'
$valeurs['GRAPH_CLIENT_SECRET'] = LireSecret 'Valeur du secret' $valeurs['GRAPH_CLIENT_SECRET']

Write-Host "`n[2] Cle API Anthropic" -ForegroundColor Cyan
Write-Host '    console.anthropic.com > Cles API. Commence par sk-ant-api03-'
$valeurs['ANTHROPIC_API_KEY'] = LireSecret 'Cle API' $valeurs['ANTHROPIC_API_KEY']

Write-Host "`n[3] Cle d acces a l interface" -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($valeurs['API_KEY']) -or $valeurs['API_KEY'] -eq 'CHANGE_MOI_CLE_SECRETE_LONGUE') {
  $octets = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($octets)
  $valeurs['API_KEY'] = 'adj-' + ([Convert]::ToBase64String($octets) -replace '[^A-Za-z0-9]', '')
  Write-Host '    Generee automatiquement.' -ForegroundColor Green
} else {
  Write-Host "    Conservee ($($valeurs['API_KEY'].Length) caracteres)." -ForegroundColor Green
}

# --- Ecriture : UTF-8 sans BOM, sinon dotenv lit mal la premiere ligne ---
$sortie = New-Object System.Collections.Generic.List[string]
$sortie.Add('# Adjointe IA - genere par scripts/configurer.ps1')
$sortie.Add('# Ne jamais versionner ni afficher ce fichier.')
$sortie.Add('')
foreach ($cle in $valeurs.Keys) { $sortie.Add("$cle=$($valeurs[$cle])") }
[System.IO.File]::WriteAllLines($envPath, $sortie, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`n[4] .env ecrit - $($valeurs.Count) lignes" -ForegroundColor Green

Write-Host "`nCle a coller dans l interface (champ en haut de la page) :" -ForegroundColor Cyan
Write-Host "    $($valeurs['API_KEY'])" -ForegroundColor White
Write-Host '    Elle ne donne acces qu a ce serveur local - aucun risque a la garder visible.' -ForegroundColor Yellow

if ((Read-Host "`nDemarrer l Adjointe maintenant ? (O/n)") -notin @('n','N')) {
  & (Join-Path $PSScriptRoot 'demarrer.ps1') -Port ([int]$valeurs['PORT'])
} else {
  Write-Host "`nPour demarrer plus tard :  .\scripts\demarrer.ps1" -ForegroundColor Cyan
}
