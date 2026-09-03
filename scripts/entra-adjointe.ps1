<#
.SYNOPSIS
  Inscrit l'application « CRC — Adjointe IA (projets) » dans Entra ID, lui accorde
  Mail.ReadWrite et Mail.Send en permissions d'APPLICATION, puis restreint sa portée
  à la seule boîte projets@c-rc.ca.

.DESCRIPTION
  Le script ne fait rien sans confirmation. Il s'arrête à la moindre erreur.
  Il se termine par le test qui compte : l'application doit être autorisée sur
  projets@c-rc.ca et REFUSÉE sur toute autre boîte.

  Prérequis (une seule fois, PowerShell en administrateur) :
    Install-Module Microsoft.Graph -Scope CurrentUser
    Install-Module ExchangeOnlineManagement -Scope CurrentUser

  Rôles requis : Administrateur d'application (ou global) + Administrateur Exchange.

.EXAMPLE
  .\entra-adjointe.ps1 -Boite projets@c-rc.ca
#>

[CmdletBinding()]
param(
  [string]$Boite = 'projets@c-rc.ca',
  [string]$NomApplication = 'CRC — Adjointe IA (projets)',
  [string]$GroupeDePortee = 'SG-Adjointe-IA-Portee',
  [int]$MoisValiditeSecret = 12
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
$PERMISSIONS  = @('Mail.ReadWrite', 'Mail.Send')

function Etape($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

Write-Host @"
------------------------------------------------------------------
 Adjointe IA — inscription d'application Entra ID
 Boîte visée      : $Boite
 Application      : $NomApplication
 Permissions      : $($PERMISSIONS -join ', ')  (APPLICATION)
 Portée verrouillée par ApplicationAccessPolicy sur $Boite
------------------------------------------------------------------
"@ -ForegroundColor Yellow

if ((Read-Host 'Continuer ? (o/N)') -notin @('o', 'O')) { Write-Host 'Annulé.'; exit }

# --- 1. Connexion --------------------------------------------------------
Etape 1 'Connexion à Microsoft Graph'
Connect-MgGraph -Scopes 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Directory.Read.All' | Out-Null
$ctx = Get-MgContext
Write-Host "    Locataire : $($ctx.TenantId)  —  compte : $($ctx.Account)"

# --- 2. Inscription ------------------------------------------------------
Etape 2 "Inscription de l'application"
$app = Get-MgApplication -Filter "displayName eq '$NomApplication'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($app) {
  Write-Host "    Application déjà existante — réutilisée (AppId $($app.AppId))" -ForegroundColor Yellow
} else {
  $app = New-MgApplication -DisplayName $NomApplication -SignInAudience 'AzureADMyOrg' `
    -Description 'Triage et brouillons de la boite projets. Portee restreinte par ApplicationAccessPolicy.'
  Write-Host "    Créée — AppId $($app.AppId)" -ForegroundColor Green
}

$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sp) { $sp = New-MgServicePrincipal -AppId $app.AppId }

# --- 3. Permissions d'application ---------------------------------------
Etape 3 'Permissions Microsoft Graph (application)'
# Les identifiants de rôle sont résolus depuis l'annuaire, jamais codés en dur.
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GRAPH_APP_ID'"
foreach ($p in $PERMISSIONS) {
  $role = $graphSp.AppRoles | Where-Object { $_.Value -eq $p -and $_.AllowedMemberTypes -contains 'Application' }
  if (-not $role) { throw "Permission $p introuvable dans le catalogue Graph." }

  $deja = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
          Where-Object { $_.AppRoleId -eq $role.Id }
  if ($deja) {
    Write-Host "    $p — déjà accordée" -ForegroundColor Yellow
  } else {
    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
      -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $role.Id | Out-Null
    Write-Host "    $p — accordée avec consentement administrateur" -ForegroundColor Green
  }
}

# --- 4. Secret client ----------------------------------------------------
Etape 4 'Secret client'
$secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
  DisplayName = "Bridge Avantage — Adjointe IA"
  EndDateTime = (Get-Date).AddMonths($MoisValiditeSecret)
}
Write-Host "    Échéance : $($secret.EndDateTime.ToString('yyyy-MM-dd')) — à inscrire au calendrier." -ForegroundColor Yellow

# --- 5. Restriction de portée — l'étape qui protège toutes les autres boîtes
Etape 5 'Restriction de portée (Exchange Online)'
Connect-ExchangeOnline -ShowBanner:$false

if (-not (Get-DistributionGroup -Identity $GroupeDePortee -ErrorAction SilentlyContinue)) {
  New-DistributionGroup -Name $GroupeDePortee -Type Security -Members $Boite | Out-Null
  Write-Host "    Groupe $GroupeDePortee créé avec $Boite" -ForegroundColor Green
  Write-Host '    Propagation du groupe — pause de 60 secondes.' -ForegroundColor Yellow
  Start-Sleep -Seconds 60
} else {
  Write-Host "    Groupe $GroupeDePortee déjà présent" -ForegroundColor Yellow
}

if (-not (Get-ApplicationAccessPolicy -ErrorAction SilentlyContinue |
          Where-Object { $_.AppId -eq $app.AppId })) {
  New-ApplicationAccessPolicy -AppId $app.AppId -PolicyScopeGroupId $GroupeDePortee `
    -AccessRight RestrictAccess -Description "Adjointe IA — $Boite uniquement" | Out-Null
  Write-Host '    Politique de restriction créée' -ForegroundColor Green
} else {
  Write-Host '    Politique déjà en place' -ForegroundColor Yellow
}

# --- 6. Vérification -----------------------------------------------------
Etape 6 'Vérification de la portée'
Write-Host '    La propagation peut prendre jusqu’à 30 minutes. Si le test ci-dessous'
Write-Host '    ne donne pas le bon résultat, relancer les deux commandes plus tard.'

$ok  = Test-ApplicationAccessPolicy -Identity $Boite -AppId $app.AppId
$non = Test-ApplicationAccessPolicy -Identity 't.villeneuve@c-rc.ca' -AppId $app.AppId
Write-Host "    $Boite -> $($ok.AccessCheckResult)"   -ForegroundColor Green
Write-Host "    t.villeneuve@c-rc.ca -> $($non.AccessCheckResult)" -ForegroundColor Green

if ($ok.AccessCheckResult -ne 'Granted' -or $non.AccessCheckResult -ne 'Denied') {
  Write-Host "`n  ATTENDU : Granted sur la boîte projets, Denied partout ailleurs." -ForegroundColor Red
  Write-Host '  NE PAS mettre le bridge en service tant que ce n’est pas le cas.' -ForegroundColor Red
}

# --- 7. Valeurs à reporter dans .env ------------------------------------
Etape 7 'À reporter dans le .env du bridge, sur le PC'
Write-Host @"

GRAPH_TENANT_ID=$($ctx.TenantId)
GRAPH_CLIENT_ID=$($app.AppId)
GRAPH_CLIENT_SECRET=$($secret.SecretText)

"@ -ForegroundColor White

Write-Host 'Le secret ne se réaffiche jamais. Copie-le directement dans le .env,' -ForegroundColor Red
Write-Host 'sur le PC du bridge — pas dans une conversation, pas dans un courriel.' -ForegroundColor Red
Write-Host "Puis : pm2 restart avantage-bridge  et ouvre  http://localhost:3000/adjointe/"

Disconnect-MgGraph | Out-Null
