# Découverte de la base de données Avantage
# ------------------------------------------------------------------------------
# À lancer sur le PC Windows qui héberge le bridge, dans PowerShell :
#
#     powershell -ExecutionPolicy Bypass -File scripts\decouvrir-bd-avantage.ps1
#
# Le script ne modifie rien. Il inspecte la machine et écrit un rapport dans
# decouverte-bd-avantage.txt, à renvoyer pour brancher le bridge sur la base.

$ErrorActionPreference = 'SilentlyContinue'
$sortie = Join-Path (Get-Location) 'decouverte-bd-avantage.txt'
$rapport = New-Object System.Collections.Generic.List[string]

function Titre($t) {
  $rapport.Add('')
  $rapport.Add('=' * 78)
  $rapport.Add("  $t")
  $rapport.Add('=' * 78)
}
function Ligne($t) { $rapport.Add($t) }

Ligne "Découverte de la base Avantage — $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Ligne "Machine : $env:COMPUTERNAME    Utilisateur : $env:USERNAME"
Ligne "Windows : $([System.Environment]::OSVersion.VersionString)  ($(if ([Environment]::Is64BitOperatingSystem) {'64 bits'} else {'32 bits'}))"

# ------------------------------------------------------------------------------
Titre '1. Pilotes ODBC installés'
try {
  $pilotes = Get-OdbcDriver -ErrorAction Stop | Sort-Object Name
  if ($pilotes) { foreach ($p in $pilotes) { Ligne ("  [{0,-7}] {1}" -f $p.Platform, $p.Name) } }
  else { Ligne '  Aucun pilote ODBC retourné.' }
} catch {
  Ligne '  Get-OdbcDriver indisponible, lecture directe du registre :'
  foreach ($cle in @('HKLM:\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers',
                     'HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBCINST.INI\ODBC Drivers')) {
    $v = Get-ItemProperty -Path $cle
    if ($v) {
      Ligne "  -- $cle"
      $v.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
        Ligne ("     {0} = {1}" -f $_.Name, $_.Value)
      }
    }
  }
}

# ------------------------------------------------------------------------------
Titre '2. Sources de données ODBC (DSN)'
try {
  $dsns = Get-OdbcDsn -ErrorAction Stop | Sort-Object Name
  if ($dsns) {
    foreach ($d in $dsns) {
      Ligne ("  [{0,-6}] {1,-28} pilote : {2}" -f $d.DsnType, $d.Name, $d.DriverName)
      if ($d.Attribute) {
        foreach ($k in $d.Attribute.Keys) {
          if ($k -notmatch '(?i)pwd|password|mot de passe') { Ligne ("       {0} = {1}" -f $k, $d.Attribute[$k]) }
          else { Ligne ("       {0} = (masqué)" -f $k) }
        }
      }
    }
  } else { Ligne '  Aucun DSN configuré.' }
} catch { Ligne '  Get-OdbcDsn indisponible sur cette version de Windows.' }

# ------------------------------------------------------------------------------
Titre '3. Moteurs de bases de données détectés'
$moteurs = @(
  @{ Nom = 'Actian Zen / Pervasive PSQL'; Motifs = @('*pervasive*', '*actian*', '*zen*', '*psql*', '*btrieve*') },
  @{ Nom = 'Microsoft SQL Server';        Motifs = @('MSSQL*', 'SQLSERVERAGENT', 'SQLBrowser') },
  @{ Nom = 'Sybase / SAP';                Motifs = @('*sybase*', '*sqlany*', '*iAnywhere*', '*ASA*') },
  @{ Nom = 'Firebird / Interbase';        Motifs = @('*firebird*', '*interbase*') },
  @{ Nom = 'Oracle';                      Motifs = @('Oracle*') },
  @{ Nom = 'MySQL / MariaDB';             Motifs = @('*mysql*', '*mariadb*') },
  @{ Nom = 'PostgreSQL';                  Motifs = @('*postgres*') }
)
$tousServices = Get-Service | Select-Object Name, DisplayName, Status
$trouve = $false
foreach ($m in $moteurs) {
  $hits = @()
  foreach ($motif in $m.Motifs) {
    $hits += $tousServices | Where-Object { $_.Name -like $motif -or $_.DisplayName -like $motif }
  }
  $hits = $hits | Sort-Object Name -Unique
  if ($hits) {
    $trouve = $true
    Ligne "  >>> $($m.Nom)"
    foreach ($h in $hits) { Ligne ("       service {0,-30} [{1}]  {2}" -f $h.Name, $h.Status, $h.DisplayName) }
  }
}
if (-not $trouve) { Ligne '  Aucun service de base de données reconnu. La base est probablement en fichiers partagés.' }

# ------------------------------------------------------------------------------
Titre '4. Contenu du répertoire de données Avantage'
$racines = @('A:\AVA01', 'A:\', 'C:\AVA01', 'C:\Avantage', 'C:\ACCEO', 'C:\Program Files (x86)\ACCEO', 'C:\Program Files\ACCEO')
if ($env:CSV_WATCH_DIR) { $racines = @($env:CSV_WATCH_DIR) + $racines }

foreach ($r in $racines) {
  if (-not (Test-Path $r)) { continue }
  Ligne ""
  Ligne "  -- $r"
  $fichiers = Get-ChildItem -Path $r -File -ErrorAction SilentlyContinue
  if (-not $fichiers) { Ligne '     (aucun fichier lisible à la racine)'; continue }

  Ligne "     Extensions présentes (indice du moteur) :"
  $fichiers | Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 15 | ForEach-Object {
    $ext = if ($_.Name) { $_.Name } else { '(sans extension)' }
    $mo = [math]::Round((($_.Group | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Ligne ("       {0,-14} {1,5} fichiers   {2,9} Mo" -f $ext, $_.Count, $mo)
  }

  Ligne "     Tables Avantage attendues :"
  foreach ($t in @('PYBBIL', 'TRANS', 'CONTRA', 'FACTMA', 'CONACT', 'CONPRE', 'ACTIVE', 'COMITE')) {
    $f = $fichiers | Where-Object { $_.BaseName -eq $t }
    if ($f) {
      foreach ($x in $f) {
        Ligne ("       {0,-10} {1,-16} {2,9} Mo   modifié {3}" -f $t, $x.Name,
               [math]::Round($x.Length / 1MB, 2), $x.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
      }
    } else {
      Ligne ("       {0,-10} absent à la racine" -f $t)
    }
  }
}

# ------------------------------------------------------------------------------
Titre '5. Signature binaire des fichiers de données'
# Les premiers octets identifient le moteur de façon fiable.
$cible = $null
foreach ($r in $racines) {
  if (Test-Path $r) {
    $c = Get-ChildItem -Path $r -File -ErrorAction SilentlyContinue |
         Where-Object { $_.BaseName -in @('PYBBIL', 'CONTRA', 'FACTMA', 'TRANS') } |
         Sort-Object Length -Descending | Select-Object -First 3
    if ($c) { $cible = $c; break }
  }
}
if ($cible) {
  foreach ($f in $cible) {
    $octets = [byte[]](Get-Content -Path $f.FullName -Encoding Byte -TotalCount 16 -ErrorAction SilentlyContinue)
    if ($octets) {
      $hex = ($octets | ForEach-Object { $_.ToString('X2') }) -join ' '
      $txt = -join ($octets | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
      Ligne ("  {0,-18} {1}" -f $f.Name, $hex)
      Ligne ("  {0,-18} {1}" -f '', $txt)
    }
  }
  Ligne ''
  Ligne '  Repères : "FC" au début = Btrieve/Actian Zen. "TPS" = Pervasive.'
  Ligne '            En-tête MS SQL = fichier .mdf. Texte lisible = fichier plat.'
} else {
  Ligne '  Aucun fichier de données Avantage localisé — préciser le chemin réel.'
}

# ------------------------------------------------------------------------------
Titre '6. Logiciels ACCEO / Avantage installés'
foreach ($cle in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty $cle |
    Where-Object { $_.DisplayName -match '(?i)acceo|avantage|pervasive|actian|btrieve|sybase' } |
    ForEach-Object { Ligne ("  {0}  —  version {1}" -f $_.DisplayName, $_.DisplayVersion) }
}

# ------------------------------------------------------------------------------
Titre '7. Écoute réseau des ports de bases de données courants'
$ports = @{ 1583 = 'Pervasive / Actian Zen'; 3351 = 'Pervasive SQL'; 1433 = 'MS SQL Server';
            2638 = 'Sybase SQL Anywhere';    3050 = 'Firebird';       5432 = 'PostgreSQL'; 3306 = 'MySQL' }
$actifs = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
foreach ($p in ($ports.Keys | Sort-Object)) {
  if ($actifs | Where-Object { $_.LocalPort -eq $p }) { Ligne ("  port {0,-6} OUVERT   {1}" -f $p, $ports[$p]) }
}
if (-not ($actifs | Where-Object { $ports.Keys -contains $_.LocalPort })) {
  Ligne '  Aucun port de base de données en écoute sur cette machine.'
}

# ------------------------------------------------------------------------------
Titre 'Fin'
Ligne "Rapport écrit dans : $sortie"

$rapport | Set-Content -Path $sortie -Encoding UTF8
$rapport | Write-Host
Write-Host ''
Write-Host "==> Renvoyer le fichier $sortie" -ForegroundColor Green
