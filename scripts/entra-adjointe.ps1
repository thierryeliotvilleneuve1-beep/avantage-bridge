<#
.SYNOPSIS
  Inscrit l'application "CRC - Adjointe IA (projets)" dans Entra ID, lui accorde
  Mail.ReadWrite et Mail.Send en permissions d'APPLICATION, puis restreint sa portee
  a la seule boite projets@c-rc.ca.

.DESCRIPTION
  Script sans accents : Windows PowerShell 5.1 lit les .ps1 en ANSI et corromprait
  les caracteres accentues. Il est idempotent - relancable sans casse.

  Prerequis (une seule fois, PowerShell en administrateur) :
    Install-Module Microsoft.Graph -Scope CurrentUser
    Install-Module ExchangeOnlineManagement -Scope CurrentUser

  Roles requis : Administrateur d'application (ou global) + Administrateur Exchange.

.EXAMPLE
  .\entra-adjointe.ps1

.EXAMPLE
  # L'inscription existe deja et on ne veut refaire que la restriction de portee :
  .\entra-adjointe.ps1 -AppIdExistant "00000000-0000-0000-0000-000000000000" -PorteeSeulement
#>

[CmdletBinding()]
param(
  [string]$Boite = 'projets@c-rc.ca',
  [string]$NomApplication = 'CRC - Adjointe IA (projets)',
  [string]$GroupeDePortee = 'SG-Adjointe-IA-Portee',
  [int]$MoisValiditeSecret = 12,
  [string]$AppIdExistant,
  [switch]$PorteeSeulement
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
$PERMISSIONS  = @('Mail.ReadWrite', 'Mail.Send')

function Etape($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

function Assert-Guid($valeur, $quoi) {
  if ([string]::IsNullOrWhiteSpace($valeur)) {
    throw "$quoi est vide. Rien ne sera cree : une politique de portee sans AppId ne protege rien."
  }
  $g = [guid]::Empty
  if (-not [guid]::TryParse($valeur, [ref]$g) -or $g -eq [guid]::Empty) {
    throw "$quoi n'est pas un GUID valide : '$valeur'"
  }
  return $valeur
}

Write-Host @"
------------------------------------------------------------------
 Adjointe IA - acces Microsoft Graph
 Boite visee : $Boite
 Application : $NomApplication
 Permissions : $($PERMISSIONS -join ', ')  (APPLICATION)
 Portee verrouillee par ApplicationAccessPolicy
------------------------------------------------------------------
"@ -ForegroundColor Yellow

if ((Read-Host 'Continuer ? (o/N)') -notin @('o', 'O')) { Write-Host 'Annule.'; exit }

$tenantId = $null
$appId    = $AppIdExistant
$secret   = $null

if (-not $PorteeSeulement) {

  Etape 1 'Connexion a Microsoft Graph'
  Connect-MgGraph -Scopes 'Application.ReadWrite.All','AppRoleAssignment.ReadWrite.All','Directory.Read.All' | Out-Null
  $ctx = Get-MgContext
  $tenantId = $ctx.TenantId
  Write-Host "    Locataire : $tenantId  -  compte : $($ctx.Account)"

  Etape 2 "Inscription de l'application"
  # Filtre echappe : une apostrophe dans le nom casserait la requete OData.
  $filtre = "displayName eq '" + $NomApplication.Replace("'", "''") + "'"
  $app = Get-MgApplication -Filter $filtre -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($app) {
    Write-Host "    Deja inscrite - reutilisee (AppId $($app.AppId))" -ForegroundColor Yellow
  } else {
    $app = New-MgApplication -DisplayName $NomApplication -SignInAudience 'AzureADMyOrg' `
      -Description 'Triage et brouillons de la boite projets. Portee restreinte par ApplicationAccessPolicy.'
    Write-Host "    Creee - AppId $($app.AppId)" -ForegroundColor Green
  }
  $appId = Assert-Guid $app.AppId "L'AppId de l'application"

  $sp = Get-MgServicePrincipal -Filter "appId eq '$appId'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sp) { $sp = New-MgServicePrincipal -AppId $appId }

  Etape 3 'Permissions Microsoft Graph (application)'
  # Les identifiants de role sont resolus depuis l'annuaire, jamais codes en dur.
  $graphSp = Get-MgServicePrincipal -Filter "appId eq '$GRAPH_APP_ID'"
  foreach ($p in $PERMISSIONS) {
    $role = $graphSp.AppRoles | Where-Object { $_.Value -eq $p -and $_.AllowedMemberTypes -contains 'Application' }
    if (-not $role) { throw "Permission $p introuvable dans le catalogue Graph." }
    $deja = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
            Where-Object { $_.AppRoleId -eq $role.Id }
    if ($deja) {
      Write-Host "    $p - deja accordee" -ForegroundColor Yellow
    } else {
      New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
        -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id | Out-Null
      Write-Host "    $p - accordee avec consentement administrateur" -ForegroundColor Green
    }
  }

  Etape 4 'Secret client'
  $secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
    DisplayName = 'Bridge Avantage - Adjointe IA'
    EndDateTime = (Get-Date).AddMonths($MoisValiditeSecret)
  }
  Write-Host "    Echeance : $($secret.EndDateTime.ToString('yyyy-MM-dd')) - a inscrire au calendrier." -ForegroundColor Yellow
}

# --- Restriction de portee - l'etape qui protege toutes les autres boites -----
$appId = Assert-Guid $appId "L'AppId a restreindre"

Etape 5 'Restriction de portee (Exchange Online)'
if (-not (Get-ConnectionInformation -ErrorAction SilentlyContinue)) {
  Connect-ExchangeOnline -ShowBanner:$false
}

if (-not (Get-DistributionGroup -Identity $GroupeDePortee -ErrorAction SilentlyContinue)) {
  New-DistributionGroup -Name $GroupeDePortee -Type Security -Members $Boite | Out-Null
  Write-Host "    Groupe $GroupeDePortee cree avec $Boite" -ForegroundColor Green
  Write-Host '    Propagation du groupe - pause de 60 secondes.' -ForegroundColor Yellow
  Start-Sleep -Seconds 60
} else {
  Write-Host "    Groupe $GroupeDePortee deja present" -ForegroundColor Yellow
}

$politique = Get-ApplicationAccessPolicy -ErrorAction SilentlyContinue |
             Where-Object { $_.AppId -eq $appId }
if ($politique) {
  Write-Host '    Politique deja en place' -ForegroundColor Yellow
} else {
  New-ApplicationAccessPolicy -AppId $appId -PolicyScopeGroupId $GroupeDePortee `
    -AccessRight RestrictAccess -Description "Adjointe IA - $Boite uniquement" | Out-Null
  Write-Host '    Politique de restriction creee' -ForegroundColor Green
}

Etape 6 'Verification de la portee'
Write-Host '    La propagation peut prendre jusqu a 30 minutes. Si le resultat n est pas'
Write-Host '    celui attendu, relancer les deux Test-ApplicationAccessPolicy plus tard.'
$ok  = Test-ApplicationAccessPolicy -Identity $Boite -AppId $appId
$non = Test-ApplicationAccessPolicy -Identity 't.villeneuve@c-rc.ca' -AppId $appId
Write-Host "    $Boite -> $($ok.AccessCheckResult)" -ForegroundColor Green
Write-Host "    t.villeneuve@c-rc.ca -> $($non.AccessCheckResult)" -ForegroundColor Green

if ($ok.AccessCheckResult -ne 'Granted' -or $non.AccessCheckResult -ne 'Denied') {
  Write-Host "`n  ATTENDU : Granted sur la boite projets, Denied partout ailleurs." -ForegroundColor Red
  Write-Host '  NE PAS mettre le bridge en service tant que ce n est pas le cas.' -ForegroundColor Red
}

Etape 7 'A reporter dans le .env du bridge, sur le PC'
Write-Host ''
if ($tenantId) { Write-Host "GRAPH_TENANT_ID=$tenantId" -ForegroundColor White }
Write-Host "GRAPH_CLIENT_ID=$appId" -ForegroundColor White
if ($secret) { Write-Host "GRAPH_CLIENT_SECRET=$($secret.SecretText)" -ForegroundColor White }
Write-Host ''
Write-Host 'Le secret ne se reaffiche jamais. Copie-le directement dans le .env,' -ForegroundColor Red
Write-Host 'sur le PC du bridge - pas dans une conversation, pas dans un courriel.' -ForegroundColor Red
Write-Host 'Puis : pm2 restart avantage-bridge  et ouvre  http://localhost:3000/adjointe/'
