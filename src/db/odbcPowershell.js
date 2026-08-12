// Accès ODBC via PowerShell — sans compilation native.
//
// POURQUOI
// Le module npm `odbc` est une extension natived : sur Windows il faut node-gyp, Python et
// les Build Tools de Visual Studio. C'est un mur avant même d'avoir essayé de lire la base.
// Or Windows embarque déjà tout ce qu'il faut : System.Data.Odbc, dans le .NET Framework
// livré avec l'OS. On passe donc par PowerShell, qui est présent partout.
//
// LECTURE SEULE — le garde-fou SELECT de src/db/connexion.js s'applique avant d'arriver ici,
// et la connexion est demandée en lecture seule. Ce module n'exécute jamais rien d'autre
// que ce qu'on lui remet.
//
// La requête et la chaîne de connexion voyagent en base64 : aucune interpolation dans le
// script, donc aucune injection possible par le contenu du SQL, et le mot de passe
// n'apparaît ni dans la ligne de commande ni dans les journaux.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EST_WINDOWS = process.platform === 'win32';
const DELAI_MS = Number(process.env.AVANTAGE_BD_DELAI_MS || 180000);

function b64(txt) {
  return Buffer.from(String(txt), 'utf8').toString('base64');
}

function executablePowershell() {
  return process.env.AVANTAGE_POWERSHELL || 'powershell.exe';
}

function disponible() {
  return EST_WINDOWS;
}

// Le script écrit son résultat dans un fichier plutôt que sur la sortie standard :
// un grand livre de plusieurs dizaines de milliers de lignes dépasse les tampons de stdout.
function scriptRequete(cibleFichier, limite) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function FromB64([string]$s) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

$cs   = FromB64 $env:AVA_CS
$sql  = FromB64 $env:AVA_SQL
$mode = $env:AVA_MODE
$cible = FromB64 $env:AVA_OUT
$limite = [int]$env:AVA_LIMITE

$cn = New-Object System.Data.Odbc.OdbcConnection
$cn.ConnectionString = $cs
$cn.Open()
try {
  if ($mode -eq 'tables' -or $mode -eq 'colonnes') {
    # GetSchema n'exécute aucune requête : il interroge le pilote.
    if ($mode -eq 'tables') { $dt = $cn.GetSchema('Tables') }
    else { $dt = $cn.GetSchema('Columns', @($null, $null, (FromB64 $env:AVA_TABLE), $null)) }
    $lignes = New-Object System.Collections.ArrayList
    foreach ($r in $dt.Rows) {
      $o = [ordered]@{}
      foreach ($c in $dt.Columns) {
        $v = $r[$c]
        if ($v -is [System.DBNull]) { $v = $null }
        $o[$c.ColumnName] = $v
      }
      [void]$lignes.Add([pscustomobject]$o)
    }
  } else {
    $cmd = $cn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 0
    $rd = $cmd.ExecuteReader()
    $lignes = New-Object System.Collections.ArrayList
    $noms = @()
    for ($i = 0; $i -lt $rd.FieldCount; $i++) { $noms += $rd.GetName($i) }
    while ($rd.Read()) {
      $o = [ordered]@{}
      for ($i = 0; $i -lt $rd.FieldCount; $i++) {
        if ($rd.IsDBNull($i)) { $v = $null } else { $v = $rd.GetValue($i) }
        # Normalisation des dates : Avantage doit ressortir en AAAA-MM-JJ.
        if ($v -is [datetime]) { $v = $v.ToString('yyyy-MM-dd') }
        elseif ($v -is [byte[]]) { $v = [Convert]::ToBase64String($v) }
        $o[$noms[$i]] = $v
      }
      [void]$lignes.Add([pscustomobject]$o)
      if ($limite -gt 0 -and $lignes.Count -ge $limite) { break }
    }
    $rd.Close()
  }

  $json = ConvertTo-Json -InputObject @($lignes) -Depth 4 -Compress
  [IO.File]::WriteAllText($cible, $json, (New-Object Text.UTF8Encoding($false)))
  Write-Output ('OK ' + $lignes.Count)
}
finally { $cn.Close() }
`;
}

function lancer(env, script) {
  return new Promise((resoudre, rejeter) => {
    const ps = executablePowershell();
    // -EncodedCommand évite tout problème de guillemets et d'échappement de shell.
    const encode = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode],
      { env: Object.assign({}, process.env, env), timeout: DELAI_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').toString().trim().split('\n').slice(0, 6).join(' ');
          return rejeter(new Error('PowerShell/ODBC : ' + (detail || err.message)));
        }
        resoudre(String(stdout || '').trim());
      }
    );
  });
}

async function appeler(mode, options) {
  if (!disponible()) throw new Error('L\'accès ODBC par PowerShell n\'est offert que sous Windows.');
  const o = options || {};
  const sortie = path.join(os.tmpdir(), 'ava-' + mode + '-' + process.pid + '-' + Date.now() + '.json');
  const env = {
    AVA_CS: b64(o.chaine || ''),
    AVA_SQL: b64(o.sql || ''),
    AVA_MODE: mode,
    AVA_OUT: b64(sortie),
    AVA_LIMITE: String(o.limite || 0),
    AVA_TABLE: b64(o.table || ''),
  };
  try {
    await lancer(env, scriptRequete(sortie, o.limite || 0));
    if (!fs.existsSync(sortie)) throw new Error('PowerShell n\'a produit aucun résultat.');
    const brut = fs.readFileSync(sortie, 'utf8');
    if (!brut.trim()) return [];
    const parse = JSON.parse(brut);
    return Array.isArray(parse) ? parse : [parse];
  } finally {
    try { if (fs.existsSync(sortie)) fs.unlinkSync(sortie); } catch (e) { /* fichier temporaire */ }
  }
}

function interroger(chaine, sql, limite) {
  return appeler('requete', { chaine, sql, limite });
}

async function listerTables(chaine) {
  const lignes = await appeler('tables', { chaine });
  return lignes.map(t => ({
    catalogue: t.TABLE_CATALOG || t.TABLE_CAT || t.TABLE_QUALIFIER || null,
    schema: t.TABLE_SCHEMA || t.TABLE_SCHEM || t.TABLE_OWNER || null,
    nom: t.TABLE_NAME,
    type: t.TABLE_TYPE,
  })).filter(t => t.nom);
}

async function listerColonnes(chaine, table) {
  const lignes = await appeler('colonnes', { chaine, table });
  return lignes.map(c => ({
    position: Number(c.ORDINAL_POSITION || c.COLUMN_POSITION || 0),
    nom: c.COLUMN_NAME,
    type: c.TYPE_NAME || c.DATA_TYPE || null,
    taille: c.COLUMN_SIZE || c.LENGTH || null,
  })).filter(c => c.nom).sort((a, b) => a.position - b.position);
}

module.exports = { disponible, interroger, listerTables, listerColonnes };
