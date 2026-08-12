#!/usr/bin/env node
//
// Dit ce qui est réellement exploitable dans les tables Avantage du poste, et où sont
// les revenus.
//
//   npm run diagnostic
//   npm run diagnostic -- 2025-08-01 2026-07-31
//
// TROIS QUESTIONS, DANS CET ORDRE
//
//   1. Chaque table se décode-t-elle ? Avantage chiffre le contenu de certaines tables :
//      les noms de champs restent lisibles, les valeurs non. Une résolution de colonnes
//      peut donc « réussir » sur une table dont pas un chiffre n'est utilisable.
//   2. Si FACTMA est illisible, le grand livre TRANS porte-t-il les comptes de produits ?
//      Si oui, les revenus se reconstruisent sans FACTMA.
//   3. Quels types de journaux et quels comptes existent, avec quels montants ?
//
// LECTURE SEULE — ouverture en lecture. Aucune écriture, et aucune tentative de
// déchiffrement : ce script constate, il ne contourne rien.

require('dotenv').config();

const dbf = require('../src/db/lecteurDbf');
const depot = require('../src/sources/depotDbf');
const gl = require('../src/parsers/parseGrandLivre');

function argent(n) {
  return (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString('fr-CA') + ' $';
}
function valider(v) { return /^\d{4}-\d{2}-\d{2}$/.test((v || '').trim()) ? v.trim() : null; }

function ilYaDesMois(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

// ── 1. Lisibilité de chaque table ────────────────────────────────────────────────
function examinerTables() {
  const etats = {};
  console.log('\n' + '='.repeat(78));
  console.log('1. CE QUI SE DÉCODE, ET CE QUI NE SE DÉCODE PAS');
  console.log('='.repeat(78));
  console.log('TABLE     ENREG.      VERSION  CHIFFR.  LISIBILITÉ');

  for (const t of depot.TABLES_ATTENDUES) {
    if (!depot.aTable(t)) {
      console.log(t.padEnd(9) + 'fichier absent');
      etats[t] = { present: false };
      continue;
    }
    try {
      const meta = depot.meta(t);
      const l = dbf.lisibilite(meta.chemin, meta, 200);
      etats[t] = { present: true, meta, lisibilite: l };
      console.log(
        t.padEnd(9) +
        meta.nbEnregistrements.toLocaleString('fr-CA').padStart(10) + '  ' +
        ('0x' + meta.version.toString(16)).padStart(8) + '  ' +
        ('0x' + (meta.drapeauChiffrement || 0).toString(16)).padStart(6) + '   ' +
        l.verdict.toUpperCase() +
        (l.taux === null ? '' : ' (' + l.taux + ' % des dates et nombres se décodent)'));
    } catch (e) {
      console.log(t.padEnd(9) + 'illisible : ' + e.message);
      etats[t] = { present: true, erreur: e.message };
    }
  }

  const illisibles = Object.entries(etats)
    .filter(([, e]) => e.lisibilite && e.lisibilite.verdict === 'illisible')
    .map(([t]) => t);
  if (illisibles.length) {
    console.log('\n→ Tables dont le contenu est chiffré ou illisible : ' + illisibles.join(', '));
    console.log('  Les noms de champs sont en clair, les valeurs non. Rien à corriger dans le');
    console.log('  mappage : il faut une autre source pour ces données.');
  }
  return etats;
}

// ── 2. et 3. Ce que porte le grand livre ─────────────────────────────────────────
// TRANS est le grand livre. S'il se décode, il contient tout : produits, charges,
// salaires, banque. On l'inventorie par type de journal puis par compte.
function sonderTrans(debut, fin) {
  console.log('\n' + '='.repeat(78));
  console.log('2. LE GRAND LIVRE TRANS, DU ' + debut + ' AU ' + fin);
  console.log('='.repeat(78));

  const meta = depot.meta('TRANS');
  const noms = meta.champs.map(c => c.nom);
  console.log('Champs : ' + noms.join(' '));

  // Les colonnes de TRANS sont positionnelles dans l'export : projet, GL, date,
  // journal, montant, activité. On confirme d'abord que la date de la 3e colonne
  // en est bien une.
  const cProj = noms[0], cGl = noms[1], cDate = noms[2],
    cJrnl = noms[3], cMt = noms[4];

  const parType = {};
  const parCompte = {};
  let total = 0, retenues = 0;

  dbf.lireTable(meta.chemin, {
    meta,
    filtre: l => {
      const date = gl.normaliserDate(l[cDate]);
      if (!date || date < debut || date > fin) return false;
      const journal = String(l[cJrnl] === null ? '' : l[cJrnl]).trim();
      const type = journal.charAt(0).toUpperCase() || '?';
      const montant = gl.nombre(l[cMt]);
      const compte = String(l[cGl] === null ? '' : l[cGl]).trim();

      retenues++;
      total += montant;

      if (!parType[type]) parType[type] = { nb: 0, montant: 0 };
      parType[type].nb++;
      parType[type].montant += montant;

      const cle = compte || '(sans compte)';
      if (!parCompte[cle]) parCompte[cle] = { nb: 0, montant: 0, projets: 0 };
      parCompte[cle].nb++;
      parCompte[cle].montant += montant;
      if (gl.normaliserProjet(l[cProj])) parCompte[cle].projets++;
      return false;
    },
  });

  console.log('\n' + retenues.toLocaleString('fr-CA') + ' écritures dans la période, ' +
    'somme algébrique ' + argent(total));

  console.log('\nPar type de journal (1er caractère) :');
  console.log('  TYPE   ÉCRITURES         MONTANT');
  Object.entries(parType).sort((a, b) => Math.abs(b[1].montant) - Math.abs(a[1].montant))
    .forEach(([t, v]) => {
      console.log('  ' + t.padEnd(6) + String(v.nb).padStart(10) + '  ' + argent(v.montant).padStart(16));
    });

  // Les comptes de produits sont ceux dont le solde est créditeur (négatif en
  // convention Avantage) ou qui commencent par 4 selon le plan comptable.
  console.log('\nComptes par famille (2 premiers chiffres) :');
  const parFamille = {};
  Object.entries(parCompte).forEach(([c, v]) => {
    const f = /^\d/.test(c) ? c.slice(0, 2) : 'autre';
    if (!parFamille[f]) parFamille[f] = { nb: 0, montant: 0, comptes: new Set() };
    parFamille[f].nb += v.nb;
    parFamille[f].montant += v.montant;
    parFamille[f].comptes.add(c);
  });
  console.log('  FAM.   COMPTES   ÉCRITURES         MONTANT');
  Object.keys(parFamille).sort().forEach(f => {
    const v = parFamille[f];
    console.log('  ' + f.padEnd(6) + String(v.comptes.size).padStart(8) +
      String(v.nb).padStart(12) + '  ' + argent(v.montant).padStart(16));
  });

  console.log('\n30 comptes aux plus gros montants :');
  console.log('  COMPTE    ÉCRITURES         MONTANT    DONT SUR PROJET');
  Object.entries(parCompte)
    .sort((a, b) => Math.abs(b[1].montant) - Math.abs(a[1].montant))
    .slice(0, 30)
    .forEach(([c, v]) => {
      console.log('  ' + c.padEnd(10) + String(v.nb).padStart(9) + '  ' +
        argent(v.montant).padStart(16) + '    ' +
        Math.round((v.projets / v.nb) * 100) + ' %');
    });
}

(async () => {
  if (!depot.disponible()) {
    console.error('Répertoire Avantage introuvable : ' + depot.raisonIndisponible());
    process.exit(1);
  }

  const debut = valider(process.argv[2]) || ilYaDesMois(12);
  const fin = valider(process.argv[3]) || new Date().toISOString().slice(0, 10);

  console.log('Répertoire : ' + depot.repertoire());
  const etats = examinerTables();

  const trans = etats.TRANS;
  if (trans && trans.lisibilite && trans.lisibilite.verdict !== 'illisible') {
    sonderTrans(debut, fin);
  } else {
    console.log('\nTRANS n\'est pas exploitable : rien à sonder dans le grand livre.');
  }

  console.log('\n' + '='.repeat(78));
  console.log('Rien n\'a été modifié : ouverture en lecture seule, aucun déchiffrement tenté.');
})().catch(e => { console.error(e.stack); process.exit(1); });
