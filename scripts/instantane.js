#!/usr/bin/env node
//
// Produit un instantané autonome de l'état des résultats : un seul fichier HTML,
// données incluses, qui s'ouvre sans serveur et se transmet par courriel.
//
//   npm run instantane
//   npm run instantane -- 2025-05-01 2026-04-30
//   npm run instantane -- 2025-01-01 2025-12-31 "CRC - Etat des resultats 2025.html"
//
// Sans argument, la période couvre les douze derniers mois.
//
// LECTURE SEULE — comme tout le module d'état des résultats, ce script ne fait que lire
// Avantage. Il n'écrit qu'un fichier HTML, à l'endroit demandé.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const etatResultats = require('../src/services/etatResultats');
const source = require('../src/sources/donneesAvantage');

const GABARIT = path.join(__dirname, '../src/views/instantane.html');

function ilYaDesMois(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

function valider(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test((v || '').trim()) ? v.trim() : null;
}

// Neutralise ce qui refermerait la balise script avant la fin des données.
function securiser(json) {
  return json.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');
}

function argent(n) {
  return (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString('fr-CA') + ' $';
}

(async () => {
  const args = process.argv.slice(2);
  const debut = valider(args[0]) || ilYaDesMois(12);
  const fin = valider(args[1]) || new Date().toISOString().slice(0, 10);
  if (fin <= debut) {
    console.error('La date de fin doit suivre la date de début.');
    process.exit(1);
  }

  const defaut = 'CRC - Etat des resultats - ' + debut + ' au ' + fin + '.html';
  const sortie = path.resolve(args[2] || defaut);

  if (!fs.existsSync(GABARIT)) {
    console.error('Gabarit introuvable : ' + GABARIT);
    process.exit(1);
  }

  console.log('Lecture d\'Avantage du ' + debut + ' au ' + fin + '…');
  const etat = await etatResultats.construire(debut, fin);

  if (!etat.qualite.lignes_de_charge && !etat.revenus.nb_factures) {
    console.error('\nAucune donnée lue pour cette période.');
    console.error('Vérifier les sources :');
    const s = source.etatSources();
    console.error('  répertoire : ' + s.repertoire_exports);
    Object.entries(s.fichiers_csv).forEach(([nom, f]) => {
      console.error('  ' + nom.padEnd(9) + (f.present ? f.taille_mo + ' Mo, modifié ' + f.modifie : 'absent'));
    });
    process.exit(1);
  }

  // On ne garde de la provenance que ce qui répond à « d'où sortent ces chiffres, et de
  // quand datent-ils ». Le reste alourdirait le fichier sans rien apprendre au lecteur.
  const charge = Object.assign({}, etat);
  charge.fraicheur = Object.entries(etat.provenance || {}).map(([jeu, p]) => ({
    jeu, mode: p.mode, detail: p.detail,
  }));
  delete charge.provenance;

  const gabarit = fs.readFileSync(GABARIT, 'utf8');
  const page = gabarit.replace('__DONNEES__', securiser(JSON.stringify(charge)));
  if (page.includes('__DONNEES__')) {
    console.error('Injection des données impossible : le gabarit a changé de forme.');
    process.exit(1);
  }

  // Le gabarit est un fragment. Par défaut on l'enveloppe pour qu'il s'ouvre seul dans un
  // navigateur ; INSTANTANE_FRAGMENT=1 le laisse nu, pour les hôtes qui fournissent
  // eux-mêmes l'enveloppe HTML.
  const complet = process.env.INSTANTANE_FRAGMENT === '1' ? page
    : '<!doctype html>\n<html lang="fr-CA">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + page.split('</style>')[0] + '</style>\n</head>\n<body>\n'
      + page.split('</style>').slice(1).join('</style>')
      + '\n</body>\n</html>\n';

  fs.writeFileSync(sortie, complet, 'utf8');

  const t = etat.totaux;
  console.log('');
  console.log('  Revenus facturés   ' + argent(t.revenus).padStart(16));
  console.log('  Coût des travaux   ' + argent(t.cout_direct).padStart(16));
  console.log('  Marge brute        ' + argent(t.marge_brute).padStart(16) + '   ' + t.marge_brute_pct + ' %');
  console.log('  Frais généraux     ' + argent(t.frais_generaux + t.non_classe).padStart(16));
  console.log('  RÉSULTAT NET       ' + argent(t.resultat_net).padStart(16) + '   ' + t.resultat_net_pct + ' %');
  console.log('');
  console.log('  ' + etat.qualite.lignes_de_charge.toLocaleString('fr-CA') + ' lignes de charge, '
    + etat.revenus.nb_factures + ' factures clients, '
    + etat.qualite.pct_non_classe + ' % non classé');
  console.log('');
  console.log('Instantané écrit : ' + sortie);
  console.log('Taille : ' + Math.round(complet.length / 1024) + ' Ko — un seul fichier, aucun serveur requis.');
  process.exit(0);
})().catch(e => {
  console.error('Échec : ' + e.message);
  process.exit(1);
});
