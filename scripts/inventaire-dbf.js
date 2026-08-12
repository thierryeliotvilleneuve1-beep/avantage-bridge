#!/usr/bin/env node
//
// Décrit les tables Avantage telles qu'elles sont réellement sur le poste : nom de chaque
// champ, son type, sa longueur, et un exemple de valeur prise dans les données.
//
//   npm run inventaire                 # toutes les tables attendues
//   npm run inventaire -- FACTMA       # une seule table
//   npm run inventaire -- FACTMA CONTRA
//
// À quoi ça sert : quand la résolution automatique des colonnes échoue, c'est parce que
// les noms de champs de cette installation d'Avantage diffèrent de ceux attendus. Cette
// sortie montre les vrais noms, avec un échantillon de contenu — de quoi corriger le
// mappage sans deviner.
//
// LECTURE SEULE — les fichiers sont ouverts en lecture. Aucune écriture, nulle part.

require('dotenv').config();

const dbf = require('../src/db/lecteurDbf');
const depot = require('../src/sources/depotDbf');

const LARGEUR_EXEMPLE = 28;

function exemple(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length > LARGEUR_EXEMPLE ? s.slice(0, LARGEUR_EXEMPLE - 1) + '…' : s;
}

(async () => {
  if (!depot.disponible()) {
    console.error('Répertoire Avantage introuvable : ' + depot.raisonIndisponible());
    console.error('Définir AVANTAGE_DBF_DIR dans .env s\'il n\'est pas à A:\\AVA01.');
    process.exit(1);
  }

  const demandees = process.argv.slice(2).map(t => t.toUpperCase());
  const tables = demandees.length ? demandees : depot.TABLES_ATTENDUES;

  console.log('Répertoire : ' + depot.repertoire());

  for (const t of tables) {
    console.log('\n' + '='.repeat(78));
    if (!depot.aTable(t)) {
      console.log(t + ' — fichier absent');
      continue;
    }

    let meta, echantillon;
    try {
      meta = depot.meta(t);
      // Échantillon réparti : la tête d'une grosse table ne contient que les années
      // anciennes, où beaucoup de champs sont vides et donneraient de faux exemples.
      echantillon = dbf.echantillonReparti(meta.chemin, 200, meta);
    } catch (e) {
      console.log(t + ' — illisible : ' + e.message);
      continue;
    }

    console.log(t + ' — ' + meta.nbEnregistrements.toLocaleString('fr-CA') + ' enregistrements, ' +
      meta.champs.length + ' champs, ' + meta.versionLibelle);
    console.log('-'.repeat(78));
    console.log('  #  NOM         TYPE  LONG   REMPLI   EXEMPLE');

    meta.champs.forEach((c, i) => {
      const valeurs = echantillon.map(l => l[c.nom])
        .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
      const pct = echantillon.length ? Math.round((valeurs.length / echantillon.length) * 100) : 0;
      console.log(
        String(i).padStart(3) + '  ' +
        c.nom.padEnd(12) + c.type.padEnd(6) +
        String(c.longueur).padStart(4) + '  ' +
        String(pct).padStart(5) + ' %   ' +
        exemple(valeurs[0]));
    });
  }

  console.log('\n' + '='.repeat(78));
  console.log('Rien n\'a été modifié : les fichiers ont été ouverts en lecture seule.');
})().catch(e => { console.error(e.stack); process.exit(1); });
