// Contrôle du lecteur .DBF.
//
// Lancer :  npm run test:dbf
//
// On fabrique de vrais fichiers .DBF octet par octet, puis on vérifie que le lecteur
// retrouve exactement ce qu'on y a mis. C'est le seul moyen de valider un format binaire
// sans la base de production — et ça couvre ce qui casse en pratique : les types de champs,
// les enregistrements supprimés, les dates vides, les nombres négatifs, un compteur
// d'enregistrements menteur.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dbf = require('../src/db/lecteurDbf');

let reussis = 0, echecs = 0;
function test(nom, fn) {
  try { fn(); reussis++; console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.log('  ÉCHEC ' + nom + '\n         ' + e.message); }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-'));

// ── Fabrique de .DBF ────────────────────────────────────────────────────────────
// champs : [{ nom, type, longueur, decimales }]
// lignes : [{ NOM: 'valeur brute déjà formatée' }] — on écrit tel quel, comme Avantage.
function ecrireDbf(nomFichier, champs, lignes, options) {
  const o = options || {};
  const longueurEnregistrement = 1 + champs.reduce((s, c) => s + c.longueur, 0);
  const longueurEnTete = 32 + champs.length * 32 + 1;

  const tete = Buffer.alloc(32, 0);
  tete[0] = o.version === undefined ? 0x03 : o.version;
  tete[1] = 126; tete[2] = 8; tete[3] = 12; // 2026-08-12
  tete.writeUInt32LE(o.nbAnnonce === undefined ? lignes.length : o.nbAnnonce, 4);
  tete.writeUInt16LE(longueurEnTete, 8);
  tete.writeUInt16LE(longueurEnregistrement, 10);
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

  const chemin = path.join(DIR, nomFichier);
  fs.writeFileSync(chemin, Buffer.concat(morceaux));
  return chemin;
}

// ── En-tête et champs ───────────────────────────────────────────────────────────
console.log('\nEn-tête et déclaration des champs');

const CHAMPS_PYBBIL = [
  { nom: 'PBSEQ', type: 'C', longueur: 9 },
  { nom: 'PBDATE', type: 'D', longueur: 8 },
  { nom: 'PBFOURN', type: 'C', longueur: 10 },
  { nom: 'PBFACT', type: 'C', longueur: 15 },
  { nom: 'PBDESC', type: 'C', longueur: 30 },
  { nom: 'PBTOTAL', type: 'N', longueur: 12, decimales: 2 },
  { nom: 'PBPROJ', type: 'C', longueur: 10 },
  { nom: 'PBGL01', type: 'C', longueur: 5 },
  { nom: 'PBMT01', type: 'N', longueur: 12, decimales: 2 },
];

const fPybbil = ecrireDbf('PYBBIL.DBF', CHAMPS_PYBBIL, [
  { PBSEQ: '000001001', PBDATE: '20260212', PBFOURN: 'F001', PBFACT: 'ST-1',
    PBDESC: 'Charpente', PBTOTAL: '120000.00', PBPROJ: '0000025007', PBGL01: '33500', PBMT01: '120000.00' },
  { PBSEQ: '000001002', PBDATE: '20260315', PBFOURN: 'F002', PBFACT: 'MT-1',
    PBDESC: 'Acier inoxydable', PBTOTAL: '22000.50', PBPROJ: '0000026004', PBGL01: '33200', PBMT01: '22000.50' },
  // Supprimé : ne doit jamais ressortir.
  { PBSEQ: '000001003', PBDATE: '20260316', PBFOURN: 'F003', PBFACT: 'ANNULE',
    PBDESC: 'Ne doit pas apparaitre', PBTOTAL: '999999.99', PBPROJ: '0000025007',
    PBGL01: '33500', PBMT01: '999999.99', __supprime: true },
  // Frais général : aucun numéro de projet.
  { PBSEQ: '000002001', PBDATE: '20260420', PBFOURN: 'G001', PBFACT: 'FG-1',
    PBDESC: 'Informatique', PBTOTAL: '18000.00', PBPROJ: '', PBGL01: '42120', PBMT01: '18000.00' },
  // Note de crédit : montant négatif.
  { PBSEQ: '000002002', PBDATE: '20260421', PBFOURN: 'G002', PBFACT: 'CR-1',
    PBDESC: 'Credit fournisseur', PBTOTAL: '-1500.25', PBPROJ: '', PBGL01: '42120', PBMT01: '-1500.25' },
  // Date vide, cas fréquent dans les fichiers hérités.
  { PBSEQ: '000002003', PBDATE: '        ', PBFOURN: 'G003', PBFACT: 'SANSDATE',
    PBDESC: 'Sans date', PBTOTAL: '10.00', PBPROJ: '', PBGL01: '42120', PBMT01: '10.00' },
]);

let meta;
test('lit la version et le format', () => {
  meta = dbf.lireEnTete(fPybbil);
  assert.strictEqual(meta.version, 0x03);
  assert.ok(/dBASE III/.test(meta.versionLibelle), meta.versionLibelle);
});

test('déclare les neuf champs avec leur type et leur longueur', () => {
  assert.strictEqual(meta.champs.length, 9);
  assert.deepStrictEqual(
    meta.champs.map(c => c.nom),
    ['PBSEQ', 'PBDATE', 'PBFOURN', 'PBFACT', 'PBDESC', 'PBTOTAL', 'PBPROJ', 'PBGL01', 'PBMT01']
  );
  const date = meta.champs.find(c => c.nom === 'PBDATE');
  assert.strictEqual(date.type, 'D');
  assert.strictEqual(date.longueur, 8);
});

test('calcule les décalages en cumulant les largeurs', () => {
  assert.strictEqual(meta.champs[0].decalage, 1, 'après le drapeau de suppression');
  assert.strictEqual(meta.champs[1].decalage, 10, '1 + 9');
  assert.strictEqual(meta.champs[8].decalage, 1 + 9 + 8 + 10 + 15 + 30 + 12 + 10 + 5);
});

test('compte les enregistrements', () => {
  assert.strictEqual(meta.nbEnregistrements, 6, 'six écrits, dont un supprimé');
});

// ── Lecture des enregistrements ─────────────────────────────────────────────────
console.log('\nLecture et conversion');

let lignes;
test('saute les enregistrements supprimés', () => {
  lignes = dbf.lireTable(fPybbil);
  assert.strictEqual(lignes.length, 5, 'le supprimé doit être écarté');
  assert.ok(!lignes.some(l => l.PBFACT === 'ANNULE'), 'l\'enregistrement effacé est ressorti');
});

test('convertit les dates en AAAA-MM-JJ', () => {
  assert.strictEqual(lignes[0].PBDATE, '2026-02-12');
  assert.strictEqual(lignes[1].PBDATE, '2026-03-15');
});

test('rend une date vide plutôt qu\'une date fausse', () => {
  const sd = lignes.find(l => l.PBFACT === 'SANSDATE');
  assert.strictEqual(sd.PBDATE, '');
});

test('convertit les numériques en nombres', () => {
  assert.strictEqual(lignes[0].PBTOTAL, 120000);
  assert.strictEqual(lignes[1].PBTOTAL, 22000.5);
  assert.strictEqual(typeof lignes[0].PBTOTAL, 'number');
});

test('conserve le signe des montants négatifs', () => {
  const cr = lignes.find(l => l.PBFACT === 'CR-1');
  assert.strictEqual(cr.PBTOTAL, -1500.25);
  assert.strictEqual(cr.PBMT01, -1500.25);
});

test('rogne les blancs de remplissage du texte', () => {
  assert.strictEqual(lignes[0].PBDESC, 'Charpente');
  assert.strictEqual(lignes[1].PBDESC, 'Acier inoxydable');
  assert.strictEqual(lignes[0].PBFOURN, 'F001');
});

test('distingue une facture de projet d\'un frais général', () => {
  assert.strictEqual(lignes[0].PBPROJ, '0000025007');
  const fg = lignes.find(l => l.PBFACT === 'FG-1');
  assert.strictEqual(fg.PBPROJ, '', 'un frais général n\'a pas de projet');
});

// ── Filtre et limite ────────────────────────────────────────────────────────────
console.log('\nFiltre et limite');

test('le filtre écarte sans charger', () => {
  const seulsProjets = dbf.lireTable(fPybbil, { filtre: l => l.PBPROJ.trim() !== '' });
  assert.strictEqual(seulsProjets.length, 2);
});

test('la limite arrête la lecture', () => {
  assert.strictEqual(dbf.lireTable(fPybbil, { limite: 2 }).length, 2);
});

test('filtre et limite se combinent', () => {
  const r = dbf.lireTable(fPybbil, { filtre: l => l.PBPROJ.trim() === '', limite: 2 });
  assert.strictEqual(r.length, 2);
  assert.ok(r.every(l => l.PBPROJ === ''));
});

// ── Robustesse ──────────────────────────────────────────────────────────────────
console.log('\nRobustesse');

test('un compteur d\'enregistrements menteur ne fait pas dépasser le fichier', () => {
  const f = ecrireDbf('MENTEUR.DBF',
    [{ nom: 'A', type: 'C', longueur: 4 }],
    [{ A: 'un' }, { A: 'deux' }],
    { nbAnnonce: 99999 });
  const m = dbf.lireEnTete(f);
  assert.ok(m.nbEnregistrements <= 3, 'annoncé ' + m.nbEnregistrementsAnnonce + ', retenu ' + m.nbEnregistrements);
  const l = dbf.lireTable(f);
  assert.strictEqual(l.length, 2, 'deux enregistrements réels');
});

test('refuse un fichier trop court', () => {
  const f = path.join(DIR, 'COURT.DBF');
  fs.writeFileSync(f, Buffer.alloc(10));
  assert.throws(() => dbf.lireEnTete(f), /trop court/);
});

test('refuse un en-tête incohérent', () => {
  const f = path.join(DIR, 'INCOHERENT.DBF');
  const b = Buffer.alloc(64, 0);
  b[0] = 0x03; b.writeUInt16LE(0, 8); b.writeUInt16LE(0, 10);
  fs.writeFileSync(f, b);
  assert.throws(() => dbf.lireEnTete(f), /incohérent/);
});

test('lit les types entier, double et monnaie', () => {
  const ent = Buffer.alloc(4); ent.writeInt32LE(-4242, 0);
  const dbl = Buffer.alloc(8); dbl.writeDoubleLE(1234.5678, 0);
  const mon = Buffer.alloc(8); mon.writeBigInt64LE(BigInt(9876543), 0); // 987,6543
  const f = ecrireDbf('TYPES.DBF', [
    { nom: 'ENT', type: 'I', longueur: 4 },
    { nom: 'DBL', type: 'B', longueur: 8 },
    { nom: 'MON', type: 'Y', longueur: 8 },
    { nom: 'BOOL', type: 'L', longueur: 1 },
  ], [{ ENT: ent, DBL: dbl, MON: mon, BOOL: 'T' }]);
  const l = dbf.lireTable(f)[0];
  assert.strictEqual(l.ENT, -4242);
  assert.ok(Math.abs(l.DBL - 1234.5678) < 1e-9, 'double : ' + l.DBL);
  assert.ok(Math.abs(l.MON - 987.6543) < 1e-9, 'monnaie : ' + l.MON);
  assert.strictEqual(l.BOOL, true);
});

test('lit un gros fichier par blocs sans tout charger', () => {
  const nb = 20000;
  const lignesNb = [];
  for (let i = 0; i < nb; i++) {
    lignesNb.push({ SEQ: String(i).padStart(9, '0'), MT: String(i) + '.00' });
  }
  const f = ecrireDbf('GROS.DBF',
    [{ nom: 'SEQ', type: 'C', longueur: 9 }, { nom: 'MT', type: 'N', longueur: 12, decimales: 2 }],
    lignesNb);
  const l = dbf.lireTable(f);
  assert.strictEqual(l.length, nb);
  assert.strictEqual(l[0].SEQ, '000000000');
  assert.strictEqual(l[nb - 1].MT, nb - 1);
  const somme = l.reduce((s, x) => s + x.MT, 0);
  assert.strictEqual(somme, (nb - 1) * nb / 2, 'somme sur tout le fichier');
});

// ── Échantillon réparti ─────────────────────────────────────────────────────────
// Régression : l'échantillonnage lisait les 300 PREMIERS enregistrements. Sur le vrai
// PYBBIL, la tête du fichier est l'année 2003, où le numéro de projet n'existait pas
// encore : le mappage était refusé à tort et le bridge basculait sur un CSV inexistant,
// donc sur aucune charge du tout, en silence.
console.log('\nÉchantillon réparti sur toute la table');

// 3 000 enregistrements : les 500 premiers ont un projet vide, comme les vieilles années.
const fEtale = (() => {
  const lignes = [];
  for (let i = 0; i < 3000; i++) {
    lignes.push({
      SEQ: String(i).padStart(9, '0'),
      PROJ: i < 500 ? '' : String(25000 + i).padStart(10, '0'),
      MT: String(i) + '.00',
    });
  }
  return ecrireDbf('ETALE.DBF', [
    { nom: 'SEQ', type: 'C', longueur: 9 },
    { nom: 'PROJ', type: 'C', longueur: 10 },
    { nom: 'MT', type: 'N', longueur: 12, decimales: 2 },
  ], lignes);
})();

test('l\'échantillon couvre toute la table, pas seulement la tête', () => {
  const ech = dbf.echantillonReparti(fEtale, 300);
  assert.strictEqual(ech.length, 300);
  const derniers = ech.filter(l => Number(l.SEQ) > 2000).length;
  // Le dernier tiers du fichier doit peser environ un tiers de l'échantillon.
  assert.ok(derniers > 90, 'devrait piocher aussi dans la fin du fichier : ' + derniers);
  const avecProjet = ech.filter(l => l.PROJ !== '').length;
  assert.ok(avecProjet / ech.length > 0.8,
    'le projet doit être renseigné sur la nette majorité de l\'échantillon : ' + avecProjet);
});

test('les 300 premiers enregistrements auraient donné un échantillon trompeur', () => {
  const tete = dbf.lireTable(fEtale, { limite: 300 });
  assert.strictEqual(tete.filter(l => l.PROJ !== '').length, 0,
    'la tête du fichier n\'a aucun projet — c\'est bien le piège qu\'on évite');
});

test('une table plus petite que l\'échantillon est retournée en entier', () => {
  const ech = dbf.echantillonReparti(fPybbil, 300);
  assert.strictEqual(ech.length, 5, 'les 5 enregistrements actifs de PYBBIL de test');
});

test('l\'échantillon réparti écarte les enregistrements supprimés', () => {
  const ech = dbf.echantillonReparti(fPybbil, 300);
  assert.ok(!ech.some(l => l.PBFACT === 'ANNULE'),
    'aucun enregistrement effacé ne doit ressortir');
});

// ── Repérage et inventaire ──────────────────────────────────────────────────────
console.log('\nRepérage des fichiers');

test('trouve un fichier quelle que soit la casse', () => {
  fs.writeFileSync(path.join(DIR, 'contra.dbf'), fs.readFileSync(fPybbil));
  assert.ok(dbf.trouverFichier(DIR, 'CONTRA'), 'contra.dbf en minuscules');
  assert.ok(dbf.trouverFichier(DIR, 'contra'), 'recherche en minuscules');
  assert.strictEqual(dbf.trouverFichier(DIR, 'INEXISTANT'), null);
});

test('l\'inventaire décrit chaque table présente', () => {
  const inv = dbf.inventaire(DIR, ['PYBBIL', 'CONTRA', 'ABSENTE']);
  assert.strictEqual(inv.PYBBIL.present, true);
  assert.strictEqual(inv.PYBBIL.nb_champs, 9);
  assert.strictEqual(inv.PYBBIL.nb_enregistrements, 6);
  assert.ok(inv.PYBBIL.champs.includes('PBDATE:D8'), inv.PYBBIL.champs.join(','));
  assert.ok(inv.PYBBIL.taille_mo >= 0);
  assert.strictEqual(inv.ABSENTE.present, false);
});

console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(echecs ? 1 : 0);
