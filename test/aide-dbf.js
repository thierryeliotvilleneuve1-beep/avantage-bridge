// Fabrique de fichiers .DBF pour les tests.
//
// Valider un lecteur de format binaire exige de vrais fichiers binaires. On les écrit donc
// octet par octet, exactement comme dBASE : en-tête de 32 octets, un descripteur de 32
// octets par champ, marqueur 0x0D, puis les enregistrements en largeur fixe précédés de
// leur drapeau de suppression.
//
// Ce module est partagé par les harnais afin qu'un seul endroit sache écrire un .DBF.
//
//   champs : [{ nom, type, longueur, decimales }]
//   lignes : [{ NOM: 'valeur brute déjà formatée' }] — écrite telle quelle, comme Avantage.
//            Un Buffer est copié tel quel, ce qui permet de simuler une table chiffrée.
//            `__supprime: true` marque l'enregistrement comme effacé.
//   options: { version, nbAnnonce } — pour éprouver un format inattendu ou un compteur
//            d'enregistrements menteur.

const fs = require('fs');
const path = require('path');

function ecrireDbfDans(repertoire, nomFichier, champs, lignes, options) {
  const o = options || {};
  const longueurEnregistrement = 1 + champs.reduce((s, c) => s + c.longueur, 0);
  const longueurEnTete = 32 + champs.length * 32 + 1;

  const tete = Buffer.alloc(32, 0);
  tete[0] = o.version === undefined ? 0x03 : o.version;
  tete[1] = 126; tete[2] = 8; tete[3] = 12; // 2026-08-12
  tete.writeUInt32LE(o.nbAnnonce === undefined ? lignes.length : o.nbAnnonce, 4);
  tete.writeUInt16LE(longueurEnTete, 8);
  tete.writeUInt16LE(longueurEnregistrement, 10);
  if (o.chiffrement !== undefined) tete[15] = o.chiffrement;
  tete[29] = 0x03; // code page Windows ANSI

  const descripteurs = Buffer.alloc(champs.length * 32, 0);
  champs.forEach((c, i) => {
    descripteurs.write(c.nom.slice(0, 10), i * 32, 11, 'latin1');
    descripteurs[i * 32 + 11] = c.type.charCodeAt(0);
    descripteurs[i * 32 + 16] = c.longueur;
    descripteurs[i * 32 + 17] = c.decimales || 0;
  });

  const morceaux = [tete, descripteurs, Buffer.from([0x0d])];

  for (const l of lignes) {
    const enr = Buffer.alloc(longueurEnregistrement, 0x20);
    enr[0] = l.__supprime ? 0x2a : 0x20;
    let d = 1;
    for (const c of champs) {
      const v = l[c.nom];
      if (v !== undefined && v !== null) {
        if (Buffer.isBuffer(v)) {
          v.copy(enr, d, 0, Math.min(v.length, c.longueur));
        } else {
          const s = String(v);
          // Les numériques sont cadrés à droite dans un .DBF, le texte à gauche.
          const t = (c.type === 'N' || c.type === 'F') ? s.padStart(c.longueur, ' ') : s;
          enr.write(t.slice(0, c.longueur), d, c.longueur, 'latin1');
        }
      }
      d += c.longueur;
    }
    morceaux.push(enr);
  }
  morceaux.push(Buffer.from([0x1a])); // marqueur de fin de fichier

  const chemin = path.join(repertoire, nomFichier);
  fs.writeFileSync(chemin, Buffer.concat(morceaux));
  return chemin;
}

// Lie la fabrique à un répertoire, pour alléger les appels dans un harnais.
function pour(repertoire) {
  return (nomFichier, champs, lignes, options) =>
    ecrireDbfDans(repertoire, nomFichier, champs, lignes, options);
}

// ── PYBBIL : 49 colonnes, dont dix paires GL/montant ────────────────────────────
// La forme reproduit celle de l'export réel, index par index, puisque c'est cette
// correspondance de positions que le bridge doit retrouver.
function champsPybbil() {
  const c = [];
  for (let i = 0; i < 49; i++) {
    if (i === 1) { c.push({ nom: 'PBDATE', type: 'D', longueur: 8 }); continue; }
    if (i === 6) { c.push({ nom: 'PBTOTAL', type: 'N', longueur: 13, decimales: 2 }); continue; }
    if (i >= 8 && i <= 27) {
      const paire = Math.floor((i - 8) / 2) + 1;
      c.push((i - 8) % 2 === 0
        ? { nom: 'PBGL' + String(paire).padStart(2, '0'), type: 'C', longueur: 5 }
        : { nom: 'PBMT' + String(paire).padStart(2, '0'), type: 'N', longueur: 13, decimales: 2 });
      continue;
    }
    if (i === 5) { c.push({ nom: 'PBDESC', type: 'C', longueur: 30 }); continue; }
    if (i === 48) { c.push({ nom: 'PBNOMFOU', type: 'C', longueur: 40 }); continue; }
    c.push({ nom: 'PBF' + String(i).padStart(2, '0'), type: 'C', longueur: 10 });
  }
  return c;
}

function lignePybbil(o) {
  const l = {
    PBF00: o.seq, PBDATE: o.date, PBF02: o.noFourn, PBF04: o.facture,
    PBDESC: o.desc, PBTOTAL: o.total, PBF33: o.projet || '', PBF44: o.commande || '',
    PBNOMFOU: o.nom,
  };
  (o.gl || []).forEach(([g, m], i) => {
    l['PBGL' + String(i + 1).padStart(2, '0')] = g;
    l['PBMT' + String(i + 1).padStart(2, '0')] = m;
  });
  if (o.supprime) l.__supprime = true;
  return l;
}

// ── TRANS : le grand livre de projet, tel qu'il est chez CRC ────────────────────
const CHAMPS_TRANS = [
  { nom: 'TCONUM', type: 'C', longueur: 10 },
  { nom: 'TNOGL', type: 'C', longueur: 5 },
  { nom: 'TDATE', type: 'D', longueur: 8 },
  { nom: 'TNOSEQ', type: 'C', longueur: 10 },
  { nom: 'TMNT', type: 'N', longueur: 14, decimales: 2 },
  { nom: 'TANUM', type: 'C', longueur: 5 },
  { nom: 'TCOMID', type: 'C', longueur: 9 },
  { nom: 'TFACT', type: 'C', longueur: 15 },
];

// Le premier caractère du numéro de séquence porte le type de journal.
function ligneTrans(o) {
  return {
    TCONUM: o.projet || '',
    TNOGL: o.compte,
    TDATE: o.date,
    TNOSEQ: (o.type || 'E') + String(o.seq || 1).padStart(6, '0'),
    TMNT: String(o.montant),
    TANUM: o.activite || '06100',
    TCOMID: o.commande || '000000000',
    TFACT: o.facture || '',
  };
}

module.exports = {
  ecrireDbfDans, pour, champsPybbil, lignePybbil, CHAMPS_TRANS, ligneTrans,
};
