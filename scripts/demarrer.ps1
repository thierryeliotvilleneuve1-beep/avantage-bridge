<#
.SYNOPSIS
  Demarre l'Adjointe IA proprement : verifie le .env, libere le port, lance le serveur.

.DESCRIPTION
  Script sans accents (Windows PowerShell 5.1 lit les .ps1 en ANSI).
  A lancer depuis le dossier du depot :  .\scripts\demarrer.ps1

.EXAMPLE
  .\scripts\demarrer.ps1
  .\scripts\demarrer.ps1 -Port 3002
#>

[CmdletBinding()]
param(
  [int]$Port = 3001
)

$ErrorActionPreference = 'Stop'
$racine = Split-Path -Parent $PSScriptRoot
Set-Location $racine

Write-Host "`n=== Adjointe IA - demarrage ===" -ForegroundColor Cyan
Write-Host "Dossier : $racine"

# --- 1. Le .env existe-t-il au bon endroit ? -----------------------------
$envPath = Join-Path $racine '.env'
if (-not (Test-Path $envPath)) {
  Write-Host "`n  .env introuvable dans $racine" -ForegroundColor Red
  Write-Host '  Faire :  copy .env.example .env   puis   notepad .env'
  exit 1
}

# --- 2. Quelles cles sont remplies ? (aucune valeur n'est affichee) ------
Write-Host "`n[1] Contenu du .env" -ForegroundColor Cyan
$lignes = Get-Content $envPath
function Valeur($cle) {
  $l = $lignes | Where-Object { $_ -match ('^' + [regex]::Escape($cle) + '=(.*)$') } | Select-Object -First 1
  if ($l) { return ($l -replace ('^' + [regex]::Escape($cle) + '='), '').Trim() }
  return $null
}

$requis = @('GRAPH_TENANT_ID','GRAPH_CLIENT_ID','GRAPH_CLIENT_SECRET','ANTHROPIC_API_KEY','API_KEY')
$manquant = @()
foreach ($c in $requis) {
  $v = Valeur $c
  $secret = $c -in @('GRAPH_CLIENT_SECRET','ANTHROPIC_API_KEY','API_KEY')
  if ([string]::IsNullOrWhiteSpace($v) -or $v -eq 'CHANGE_MOI_CLE_SECRETE_LONGUE') {
    $manquant += $c
    Write-Host ("    {0,-22} MANQUANT" -f $c) -ForegroundColor Red
  } elseif ($secret) {
    Write-Host ("    {0,-22} rempli ({1} caracteres)" -f $c, $v.Length) -ForegroundColor Green
  } else {
    Write-Host ("    {0,-22} {1}" -f $c, $v) -ForegroundColor Green
  }
}
foreach ($c in @('ADJOINTE_NIVEAU','ADJOINTE_MAILBOX','CRON_SCHEDULE')) {
  Write-Host ("    {0,-22} {1}" -f $c, (Valeur $c))
}

if ($manquant.Count) {
  Write-Host "`n  A remplir avant de demarrer : $($manquant -join ', ')" -ForegroundColor Red
  Write-Host "  notepad `"$envPath`""
  exit 1
}

# --- 3. Le port est-il deja pris ? --------------------------------------
Write-Host "`n[2] Port $Port" -ForegroundColor Cyan
$occupe = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occupe) {
  $pidOccupant = ($occupe | Select-Object -First 1).OwningProcess
  $proc = Get-Process -Id $pidOccupant -ErrorAction SilentlyContinue
  Write-Host "    Occupe par $($proc.ProcessName) (PID $pidOccupant)" -ForegroundColor Yellow
  if ((Read-Host '    Arreter ce processus ? (o/N)') -in @('o','O')) {
    Stop-Process -Id $pidOccupant -Force
    Start-Sleep -Seconds 2
    Write-Host '    Arrete.' -ForegroundColor Green
  } else {
    Write-Host '    Relancer avec un autre port :  .\scripts\demarrer.ps1 -Port 3002' -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Host '    Libre' -ForegroundColor Green
}

# --- 4. Demarrage --------------------------------------------------------
Write-Host "`n[3] Demarrage - interface sur http://localhost:$Port/adjointe/" -ForegroundColor Cyan
Write-Host "    Ctrl+C pour arreter. Les lignes qui suivent sont la sortie du serveur.`n" -ForegroundColor Yellow
$env:PORT = $Port
node src/index.js
