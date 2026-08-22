/**
 * Chargement des exports Avantage.
 *
 * Centralise la lecture des CSV/XLSX : la meme logique etait dupliquee entre
 * routes/budget.js et routes/trans-sync.js, avec des divergences silencieuses.
 *
 * Regle appliquee partout ici : une source absente renvoie `disponible: false`
 * et JAMAIS des zeros. Un zero ecrit dans Manoeuvre a partir d'un fichier
 * manquant efface une donnee reelle — c'est exactement ce qu'il faut eviter.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const EXPORT_DIR = process.env.EXPORT_DIR
  ? path.resolve(process.env.EXPORT_DIR)
  : path.resolve(__dirname, '../../exports-avantage');

const MO_CODES = (process.env.MO_CODES || '06101').split(',').map((s) => s.trim()).filter(Boolean);
const GL_TAXES = ['21340', '21370', '21310', '21300'];

function normActivite(v) {
  return (v || '').toString().trim().replace(/\.00$/, '');
}

function toNumber(v) {
  return parseFloat((v || '0').toString().replace(/\s/g, '').replace(',', '.')) || 0;
}

function memeProjet(valeur, code) {
  const a = parseInt((valeur || '').toString().trim(), 10);
  const b = parseInt(code, 10);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Cache de lecture, clef = fichier + mode + horodatage du fichier.
 *
 * La vue portefeuille appelle les chargeurs une fois par projet : sans cache,
 * TRANS.csv et PYBBIL.csv seraient reparses autant de fois qu'il y a de
 * projets. L'invalidation par mtime garantit qu'un nouvel export deposé est
 * pris en compte immediatement, sans redemarrage du service.
 */
const cacheCsv = new Map();

function viderCache() {
  cacheCsv.clear();
}

function lireCsv(nom, { entetes = false } = {}) {
  const p = path.join(EXPORT_DIR, nom);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    return { disponible: false, source: nom, rows: [] };
  }

  const clef = `${p}|${entetes ? 'h' : 'p'}|${stat.mtimeMs}|${stat.size}`;
  const enCache = cacheCsv.get(clef);
  if (enCache) return enCache;

  let resultat;
  try {
    const content = fs.readFileSync(p, 'latin1');
    const rows = parse(content, {
      columns: entetes,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      ...(entetes ? {} : { from_line: 2 }),
    });
    resultat = { disponible: true, source: nom, rows, maj: stat.mtime.toISOString() };
  } catch (e) {
    resultat = { disponible: false, source: nom, rows: [], erreur: e.message };
  }

  // Une seule entree par (fichier, mode) : les versions perimees sont evincees.
  for (const k of cacheCsv.keys()) {
    if (k.startsWith(`${p}|${entetes ? 'h' : 'p'}|`)) cacheCsv.delete(k);
  }
  cacheCsv.set(clef, resultat);
  return resultat;
}

function trouverCle(cles, ...fragments) {
  return cles.find((k) => fragments.some((f) => k.toLowerCase().includes(f.toLowerCase())));
}

/** ACTIVE.csv — libelles des activites. [0]=code [1]=description FR */
function loadActive() {
  const { disponible, rows, source, maj } = lireCsv('ACTIVE.csv');
  const map = {};
  rows.forEach((r) => {
    const code = normActivite(r[0]);
    if (code) map[code] = (r[1] || code).toString().trim();
  });
  return { disponible, source, maj, map };
}

/** CONPRE.csv — budget de COUTS previsionnel par activite. */
function loadConpre(code) {
  const { disponible, rows, source, maj } = lireCsv('CONPRE.csv', { entetes: true });
  const map = {};
  if (rows.length) {
    const cles = Object.keys(rows[0]);
    const kProjet = trouverCle(cles, 'projet', 'CPCONUM');
    const kActivite = trouverCle(cles, 'activit', 'CPACT');
    const kMontant = trouverCle(cles, 'visionnel', 'montant', 'CPMNT');
    rows
      .filter((r) => memeProjet(r[kProjet], code))
      .forEach((r) => {
        const act = normActivite(r[kActivite]);
        if (act) map[act] = (map[act] || 0) + toNumber(r[kMontant]);
      });
  }
  return { disponible, source, maj, map };
}

/**
 * CONFIT.csv — budget de REVENUS contractuel par activite (couts + profit).
 * C'est le numerateur de la marge : sans lui, aucune marge n'est calculable.
 * On ne retient que la derniere demande de paiement (DP) par activite.
 */
function loadConfit(code) {
  const { disponible, rows, source, maj } = lireCsv('CONFIT.csv', { entetes: true });
  const map = {};
  let colonnesTrouvees = false;
  if (rows.length) {
    const cles = Object.keys(rows[0]);
    const kProjet = trouverCle(cles, 'CICONUM', 'projet', 'conum');
    const kActivite = trouverCle(cles, 'CIANUM', 'activit', 'anum');
    const kRevenu = trouverCle(cles, 'CIREV', 'revenu');
    const kDp = trouverCle(cles, 'CIDP', 'demande', 'dp');
    colonnesTrouvees = Boolean(kProjet && kActivite && kRevenu);
    if (colonnesTrouvees) {
      const dernierDp = {};
      rows
        .filter((r) => memeProjet(r[kProjet], code))
        .forEach((r) => {
          const act = normActivite(r[kActivite]);
          if (!act) return;
          const dp = kDp ? toNumber(r[kDp]) : 0;
          if (dernierDp[act] === undefined || dp >= dernierDp[act]) {
            dernierDp[act] = dp;
            map[act] = toNumber(r[kRevenu]);
          }
        });
    }
  }
  return {
    disponible: disponible && colonnesTrouvees,
    fichier_present: disponible,
    colonnes_trouvees: colonnesTrouvees,
    source,
    maj,
    map,
  };
}

/** CONACT.csv — [0]=projet [1]=activite [2]=pct [3]=depense a venir [4]=facture a date. */
function loadConact(code) {
  const { disponible, rows, source, maj } = lireCsv('CONACT.csv');
  const map = {};
  rows
    .filter((r) => memeProjet(r[0], code))
    .forEach((r) => {
      const act = normActivite(r[1]);
      if (!act) return;
      if (!map[act]) map[act] = { pct: 0, depense_a_venir: 0, facture: 0 };
      map[act].pct = toNumber(r[2]);
      map[act].depense_a_venir += toNumber(r[3]);
      map[act].facture += toNumber(r[4]);
    });
  return { disponible, source, maj, map };
}

/**
 * TRANS.csv — depenses reelles par activite.
 * [0]=projet [1]=GL [2]=date [3]=type+journal [4]=montant [5]=activite
 * Type R = comptes-clients (revenus), exclu des couts.
 */
function loadTrans(code) {
  const { disponible, rows, source, maj } = lireCsv('TRANS.csv');
  const couts = {};
  const mo = {};
  rows
    .filter((r) => memeProjet(r[0], code))
    .filter((r) => (r[3] || '').toString().trim().charAt(0) !== 'R')
    .forEach((r) => {
      const act = normActivite(r[5]);
      if (!act) return;
      const montant = toNumber(r[4]);
      const cible = MO_CODES.includes(act) ? mo : couts;
      cible[act] = (cible[act] || 0) + montant;
    });
  return { disponible, source, maj, couts, mo };
}

/** COMITE.csv — [16]=num sequentiel commande [17]=code activite. */
function loadComiteDivisionMap() {
  const { disponible, rows, source, maj } = lireCsv('COMITE.csv');
  const map = {};
  rows.forEach((r) => {
    const cmd = (r[16] || '').toString().trim().padStart(9, '0');
    const act = normActivite(r[17]);
    if (cmd && cmd !== '000000000' && act && !map[cmd]) map[cmd] = act;
  });
  return { disponible, source, maj, map };
}

/** Montant net d'une ligne PYBBIL (paires GL/montant en col 8..27, taxes exclues). */
function montantNetPybbil(r) {
  let total = 0;
  for (let i = 0; i <= 9; i++) {
    const gl = (r[8 + i * 2] || '').toString().trim();
    const mt = parseFloat(r[9 + i * 2]) || 0;
    if (gl && !GL_TAXES.includes(gl)) total += mt;
  }
  return total !== 0 ? total : parseFloat(r[6]) || 0;
}

/** PYBBIL.csv — factures fournisseurs. [33]=projet [44]=no commande. */
function loadPybbilParCommande(code) {
  const { disponible, rows, source, maj } = lireCsv('PYBBIL.csv');
  const parCommande = {};
  let sansCommande = 0;
  rows
    .filter((r) => memeProjet(r[33], code))
    .forEach((r) => {
      const brut = (r[44] || '').toString().trim();
      const montant = montantNetPybbil(r);
      if (brut) {
        const cmd = brut.padStart(9, '0');
        parCommande[cmd] = (parCommande[cmd] || 0) + montant;
      } else {
        sansCommande += montant;
      }
    });
  return { disponible, source, maj, parCommande, sansCommande };
}

/** COMMAN (feuille de export.xlsx) — bons de commande, source de l'engagement. */
/**
 * Lecture de la feuille COMMAN de export.xlsx, memoisee comme les CSV.
 * Le parsing d'un classeur Excel coute nettement plus cher qu'un CSV : sans
 * cache, la vue portefeuille le refaisait une fois par projet.
 */
function lireComman() {
  const p = path.join(EXPORT_DIR, 'export.xlsx');
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    return { disponible: false, rows: [] };
  }

  const clef = `${p}|xlsx|${stat.mtimeMs}|${stat.size}`;
  const enCache = cacheCsv.get(clef);
  if (enCache) return enCache;

  let resultat;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(p);
    const ws = wb.Sheets.COMMAN;
    resultat = ws
      ? { disponible: true, rows: XLSX.utils.sheet_to_json(ws, { defval: '' }), maj: stat.mtime.toISOString() }
      : { disponible: false, rows: [], erreur: 'feuille COMMAN absente' };
  } catch (e) {
    resultat = { disponible: false, rows: [], erreur: e.message };
  }

  for (const k of cacheCsv.keys()) {
    if (k.startsWith(`${p}|xlsx|`)) cacheCsv.delete(k);
  }
  cacheCsv.set(clef, resultat);
  return resultat;
}

function loadComman(code) {
  const lu = lireComman();
  const source = 'export.xlsx#COMMAN';
  if (!lu.disponible) return { disponible: false, source, bcs: [], erreur: lu.erreur };
  const rows = lu.rows;
  if (!rows.length) return { disponible: true, source, maj: lu.maj, bcs: [] };

  const cles = Object.keys(rows[0]);
  const kProjet = trouverCle(cles, 'projet');
  const kSeqCommande = cles.find((k) => k.includes('quentiel') && k.includes('commande'));
  const kSeq = cles.find((k) => k.includes('quentiel') && !k.includes('commande'));
  const kMontant = trouverCle(cles, 'sous-total');
  const kNomFournisseur = cles.find((k) => k.toLowerCase() === 'nom du fournisseur');
  const kStatut = trouverCle(cles, 'statut');

  const bcs = rows
    .filter((r) => memeProjet(r[kProjet], code))
    .map((r) => {
      const numero = ((r[kSeqCommande] || r[kSeq] || '').toString().trim()).padStart(9, '0');
      return {
        numero,
        fournisseur: (r[kNomFournisseur] || '').toString().trim(),
        montant_prevu: parseFloat(r[kMontant]) || 0,
        statut: (r[kStatut] || '').toString() === '0' ? 'ouvert' : 'ferme',
      };
    })
    .filter((bc) => bc.numero && bc.numero !== '000000000');

  return { disponible: true, source, maj: lu.maj, bcs };
}

/**
 * Liste les numeros de projet presents dans le controle de projet Avantage.
 * Sert a construire la vue portefeuille sans dependre de Manoeuvre.
 */
function listerProjets() {
  const { disponible, rows, source, maj } = lireCsv('CONPRE.csv', { entetes: true });
  const codes = new Set();
  if (rows.length) {
    const cles = Object.keys(rows[0]);
    const kProjet = trouverCle(cles, 'projet', 'CPCONUM');
    rows.forEach((r) => {
      const n = parseInt((r[kProjet] || '').toString().trim(), 10);
      if (Number.isFinite(n) && n > 0) codes.add(String(n));
    });
  }
  return { disponible, source, maj, codes: [...codes].sort() };
}

module.exports = {
  EXPORT_DIR,
  MO_CODES,
  listerProjets,
  viderCache,
  normActivite,
  toNumber,
  memeProjet,
  montantNetPybbil,
  loadActive,
  loadConpre,
  loadConfit,
  loadConact,
  loadTrans,
  loadComiteDivisionMap,
  loadPybbilParCommande,
  loadComman,
};
