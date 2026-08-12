// Lecture directe des fichiers .DBF d'Avantage.
//
// POURQUOI C'EST LA BONNE VOIE
// Avantage stocke ses tables en dBASE/FoxPro : A:\AVA01\PYBBIL.DBF, TRANS.DBF, FACTMA.DBF…
// Ces fichiers sont la base elle-même, pas un export. Les lire directement supprime d'un
// coup trois dépendances : plus d'export CSV à relancer, plus de pilote ODBC à installer,
// plus de noms de colonnes à devineriser — un .DBF déclare ses champs dans son en-tête.
//
// LECTURE SEULE — ce module ouvre les fichiers en lecture ('r') et n'expose aucune écriture.
//
// FORMAT (dBASE III/IV, Visual FoxPro)
//   En-tête, 32 octets :
//     0      version (0x03 dBASE III, 0x04/0x05 dBASE IV/V, 0x30 VFP, 0x83/0x8B avec mémo)
//     1..3   date de dernière modification (AA MM JJ)
//     4..7   nombre d'enregistrements (entier 32 bits, petit-boutiste)
//     8..9   longueur de l'en-tête
//     10..11 longueur d'un enregistrement
//     29     code page
//   Puis un descripteur de 32 octets par champ, la liste se terminant par 0x0D :
//     0..10  nom (ASCII, complété de zéros)
//     11     type (C texte, N/F numérique, D date, L booléen, M mémo, I entier, Y monnaie, T horodatage, B double)
//     16     longueur
//     17     décimales
//   Puis les enregistrements : 1 octet de suppression (0x20 actif, 0x2A supprimé) suivi
//   des champs en largeur fixe.

const fs = require('fs');
const path = require('path');

const SUPPRIME = 0x2a;
const FIN_DESCRIPTEURS = 0x0d;

const VERSIONS = {
  0x02: 'FoxBASE',
  0x03: 'dBASE III+ sans mémo',
  0x04: 'dBASE IV sans mémo',
  0x05: 'dBASE V sans mémo',
  0x30: 'Visual FoxPro',
  0x31: 'Visual FoxPro avec incrément automatique',
  0x32: 'Visual FoxPro avec Varchar',
  0x43: 'dBASE IV table SQL',
  0x7b: 'dBASE IV avec mémo',
  0x83: 'dBASE III+ avec mémo',
  0x8b: 'dBASE IV avec mémo',
  0x8e: 'dBASE IV avec SQL',
  0xf5: 'FoxPro avec mémo',
  0xfb: 'FoxPro',
};

// Lit l'en-tête et les descripteurs de champs. Ne touche pas aux enregistrements.
function lireEnTete(chemin) {
  const fd = fs.openSync(chemin, 'r');
  try {
    const tete = Buffer.alloc(32);
    if (fs.readSync(fd, tete, 0, 32, 0) < 32) {
      throw new Error('fichier trop court pour être un .DBF');
    }

    const version = tete[0];
    const nbEnregistrements = tete.readUInt32LE(4);
    const longueurEnTete = tete.readUInt16LE(8);
    const longueurEnregistrement = tete.readUInt16LE(10);
    const codePage = tete[29];

    if (longueurEnTete < 33 || longueurEnregistrement < 1) {
      throw new Error('en-tête .DBF incohérent (en-tête ' + longueurEnTete +
        ' octets, enregistrement ' + longueurEnregistrement + ' octets)');
    }

    // Descripteurs : de l'octet 32 jusqu'au marqueur 0x0D.
    const zone = Buffer.alloc(longueurEnTete - 32);
    fs.readSync(fd, zone, 0, zone.length, 32);

    const champs = [];
    let decalage = 1; // le premier octet de l'enregistrement est le drapeau de suppression
    for (let i = 0; i + 32 <= zone.length; i += 32) {
      if (zone[i] === FIN_DESCRIPTEURS || zone[i] === 0x00) break;
      const nom = zone.slice(i, i + 11).toString('latin1').replace(/\0.*$/, '').trim();
      if (!nom) break;
      const longueur = zone[i + 16];
      champs.push({
        nom,
        type: String.fromCharCode(zone[i + 11]),
        longueur,
        decimales: zone[i + 17],
        decalage,
      });
      decalage += longueur;
    }

    if (!champs.length) throw new Error('aucun champ déclaré dans l\'en-tête');

    const taille = fs.fstatSync(fd).size;
    // Le nombre d'enregistrements annoncé est parfois faux sur des fichiers malmenés.
    // On calcule aussi le nombre réellement contenu et on garde le plus petit.
    const calcule = Math.max(0, Math.floor((taille - longueurEnTete) / longueurEnregistrement));

    return {
      chemin,
      version,
      versionLibelle: VERSIONS[version] || ('inconnue (0x' + version.toString(16) + ')'),
      codePage,
      nbEnregistrementsAnnonce: nbEnregistrements,
      nbEnregistrements: Math.min(nbEnregistrements, calcule) || calcule,
      longueurEnTete,
      longueurEnregistrement,
      tailleFichier: taille,
      champs,
      avecMemo: [0x7b, 0x83, 0x8b, 0x8e, 0xf5, 0x30, 0x31, 0x32].includes(version),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function nombre(txt) {
  const s = txt.replace(/\s/g, '');
  if (!s || s === '.' || /^[-.]+$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Convertit un champ brut selon son type déclaré.
function convertir(champ, brut) {
  switch (champ.type) {
    case 'C': // texte
      return brut.toString('latin1').replace(/\0/g, '').trim();
    case 'N':
    case 'F':
      return nombre(brut.toString('latin1'));
    case 'D': { // AAAAMMJJ
      const s = brut.toString('latin1').trim();
      if (!/^\d{8}$/.test(s)) return '';
      const a = s.slice(0, 4), m = s.slice(4, 6), j = s.slice(6, 8);
      if (a === '0000' || m === '00' || j === '00') return '';
      return a + '-' + m + '-' + j;
    }
    case 'L': { // booléen
      const c = brut.toString('latin1').trim().toUpperCase();
      if (['T', 'Y', '1'].includes(c)) return true;
      if (['F', 'N', '0'].includes(c)) return false;
      return null;
    }
    case 'I': // entier 32 bits
      return brut.length >= 4 ? brut.readInt32LE(0) : null;
    case 'Y': // monnaie : entier 64 bits à quatre décimales
      return brut.length >= 8 ? Number(brut.readBigInt64LE(0)) / 10000 : null;
    case 'B': // double
      return brut.length >= 8 ? brut.readDoubleLE(0) : null;
    case 'T': { // horodatage : deux entiers 32 bits (jour julien, millisecondes)
      if (brut.length < 8) return '';
      const jour = brut.readInt32LE(0);
      if (!jour) return '';
      // Jour julien 2440588 = 1970-01-01
      const ms = (jour - 2440588) * 86400000 + brut.readInt32LE(4);
      const d = new Date(ms);
      return isNaN(d) ? '' : d.toISOString().slice(0, 10);
    }
    case 'M': // mémo : renvoie le pointeur, le contenu vit dans le .FPT/.DBT
      return brut.toString('latin1').trim();
    default:
      return brut.toString('latin1').trim();
  }
}

// Parcourt les enregistrements actifs. `options.limite` borne le nombre retourné,
// `options.filtre(objet)` permet d'écarter une ligne sans la conserver en mémoire —
// indispensable sur PYBBIL, qui compte des centaines de milliers d'enregistrements.
function lireTable(chemin, options) {
  const o = options || {};
  const meta = o.meta || lireEnTete(chemin);
  const limite = o.limite || 0;
  const filtre = o.filtre || null;

  const fd = fs.openSync(chemin, 'r');
  const sorties = [];
  try {
    // Lecture par blocs d'environ 4 Mo, alignés sur la taille d'un enregistrement.
    const parBloc = Math.max(1, Math.floor((4 * 1024 * 1024) / meta.longueurEnregistrement));
    const tampon = Buffer.alloc(parBloc * meta.longueurEnregistrement);

    let lus = 0;
    let position = meta.longueurEnTete;
    while (lus < meta.nbEnregistrements) {
      const reste = meta.nbEnregistrements - lus;
      const combien = Math.min(parBloc, reste);
      const octets = fs.readSync(fd, tampon, 0, combien * meta.longueurEnregistrement, position);
      if (octets <= 0) break;
      const dispo = Math.floor(octets / meta.longueurEnregistrement);

      for (let k = 0; k < dispo; k++) {
        const base = k * meta.longueurEnregistrement;
        if (tampon[base] === SUPPRIME) continue; // enregistrement effacé

        const objet = {};
        for (const c of meta.champs) {
          const d = base + c.decalage;
          objet[c.nom] = convertir(c, tampon.slice(d, d + c.longueur));
        }
        if (filtre && !filtre(objet)) continue;
        sorties.push(objet);
        if (limite && sorties.length >= limite) return sorties;
      }

      lus += dispo;
      position += dispo * meta.longueurEnregistrement;
      if (dispo < combien) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return sorties;
}

// Localise un fichier de table, quelle que soit la casse du nom.
function trouverFichier(repertoire, nomTable) {
  if (!fs.existsSync(repertoire)) return null;
  const cible = nomTable.toUpperCase();
  let entrees;
  try { entrees = fs.readdirSync(repertoire); } catch (e) { return null; }
  for (const e of entrees) {
    const p = path.parse(e);
    if (p.name.toUpperCase() === cible && p.ext.toUpperCase() === '.DBF') {
      return path.join(repertoire, e);
    }
  }
  return null;
}

// Inventaire d'un répertoire Avantage : ce qui est présent, avec fraîcheur et volume.
function inventaire(repertoire, tables) {
  const res = {};
  for (const t of tables) {
    const f = trouverFichier(repertoire, t);
    if (!f) { res[t] = { present: false }; continue; }
    try {
      const st = fs.statSync(f);
      const meta = lireEnTete(f);
      res[t] = {
        present: true,
        fichier: f,
        taille_mo: Math.round((st.size / 1048576) * 100) / 100,
        modifie: st.mtime.toISOString(),
        format: meta.versionLibelle,
        nb_enregistrements: meta.nbEnregistrements,
        nb_champs: meta.champs.length,
        champs: meta.champs.map(c => c.nom + ':' + c.type + c.longueur),
      };
    } catch (e) {
      res[t] = { present: true, fichier: f, erreur: e.message };
    }
  }
  return res;
}

module.exports = { lireEnTete, lireTable, trouverFichier, inventaire, convertir, VERSIONS };
