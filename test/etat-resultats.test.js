// Contrôle de l'état des résultats sur un jeu de données de référence.
//
// Lancer :  npm test
//
// Vérifie trois choses :
//   1. la connexion Avantage refuse toute écriture ;
//   2. les totaux se réconcilient exactement d'un niveau de drill-down au suivant ;
//   3. la classification range les charges au bon endroit, et n'en perd aucune.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Jeu de contrôle isolé, écrit avant le chargement des modules qui lisent EXPORT_DIR.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'avantage-test-'));
process.env.AVANTAGE_EXPORT_DIR = DIR;
process.env.AVANTAGE_BD_ACTIVE = 'false';

let reussis = 0, echecs = 0;
function test(nom, fn) {
  return Promise.resolve().then(fn).then(
    () => { reussis++; console.log('  ok   ' + nom); },
    e => { echecs++; console.log('  ÉCHEC ' + nom + '\n         ' + e.message); }
  );
}

// ------------------------------------------------------------------ fixtures
// PYBBIL est positionnel : 49 colonnes utiles. On construit les lignes par index
// pour coller exactement au format de l'export Avantage.
function lignePybbil({ seq, date, noFourn, noFacture, description, total, projet, commande, nomFourn, ventilation }) {
  const c = new Array(49).fill('');
  c[0] = seq; c[1] = date; c[2] = noFourn; c[4] = noFacture; c[5] = description;
  c[6] = total; c[33] = projet; c[44] = commande; c[48] = nomFourn;
  (ventilation || []).forEach(([gl, montant], i) => {
    c[8 + i * 2] = gl;
    c[9 + i * 2] = montant;
  });
  return c.join(',');
}

function ecrireFixtures() {
  // -- PYBBIL : factures fournisseurs
  const pybbil = [
    'en-tete', // l'export a une ligne d'en-tête, les parsers lisent à partir de la 2e
    // Coûts de projet
    lignePybbil({ seq: '1001', date: '2026-03-05', noFourn: 'F001', noFacture: 'A-100',
      description: 'Contrat charpente', total: '50000', projet: '25007', commande: '2087',
      nomFourn: 'GROUPE JLF CONSTRUCTION INC.', ventilation: [['33500', '50000']] }),
    lignePybbil({ seq: '1002', date: '2026-03-12', noFourn: 'F002', noFacture: 'B-200',
      description: 'Materiaux', total: '11497.50', projet: '25007', commande: '',
      nomFourn: 'BOULAY INOX INC.', ventilation: [['33200', '10000'], ['21300', '500'], ['21340', '997.50']] }),
    lignePybbil({ seq: '1003', date: '2026-04-02', noFourn: 'F003', noFacture: 'C-300',
      description: 'Location nacelle', total: '3000', projet: '26004', commande: '',
      nomFourn: 'LOCATION EQUIPEMENTS RAYDAN', ventilation: [['33200', '3000']] }),
    // Frais généraux — aucun numéro de projet
    lignePybbil({ seq: '2001', date: '2026-01-15', noFourn: 'G001', noFacture: 'ASS-1',
      description: 'Prime annuelle', total: '18225', projet: '', commande: '',
      nomFourn: 'AVIVA ASSURANCE', ventilation: [['52100', '18225']] }),
    lignePybbil({ seq: '2002', date: '2026-02-20', noFourn: 'G002', noFacture: 'HON-7',
      description: 'Etats financiers', total: '2629.52', projet: '', commande: '',
      nomFourn: 'MALLETTE S.E.N.C.R.L.', ventilation: [] }), // sans GL : classé par fournisseur
    lignePybbil({ seq: '2003', date: '2026-02-28', noFourn: 'G003', noFacture: 'RBQ-1',
      description: 'Licence', total: '605.04', projet: '', commande: '',
      nomFourn: 'REGIE DU BATIMENT DU QUEBEC', ventilation: [] }),
    // GL inconnu, hors projet : doit tomber dans « À classer », pas disparaître
    lignePybbil({ seq: '2004', date: '2026-03-30', noFourn: 'G004', noFacture: 'X-9',
      description: 'Divers', total: '1500', projet: '', commande: '',
      nomFourn: 'FOURNISSEUR MYSTERE', ventilation: [['99999', '1500']] }),
    // Hors période : ne doit pas être compté
    lignePybbil({ seq: '3001', date: '2025-06-01', noFourn: 'F001', noFacture: 'OLD-1',
      description: 'Ancienne facture', total: '99999', projet: '25007', commande: '',
      nomFourn: 'GROUPE JLF CONSTRUCTION INC.', ventilation: [['33500', '99999']] }),
  ].join('\n');

  // -- TRANS : [0]projet [1]GL [2]date [3]journal [4]montant [5]activite
  const trans = [
    'en-tete',
    '25007,34100,2026-03-15,E00123,20000,06100',
    '25007,34200,2026-03-15,E00124,5000,06100',
    '26004,34100,2026-04-20,E00125,8000,00400',
    ',34100,2026-02-10,E00126,12000,',          // salaire sans projet -> frais général
    '25007,11000,2026-03-16,B00500,1234,06100', // bancaire, GL inconnu
    '25007,34100,2025-05-01,E00001,77777,06100', // hors période
  ].join('\n');

  // -- FACTMA : facturation client (export à en-tête)
  const factma = [
    'FFNOFACT,FFCONT,FFVENTE,FFDATE,FFTOTDU,FFSOLDE,FFMNTRET',
    'F-5001,25007,CONSEIL DE LA NATION ATIKAMEKW,2026-03-31,150000,0,7500',
    'F-5002,25007,CONSEIL DE LA NATION ATIKAMEKW,2026-04-30,90000,90000,4500',
    'F-5003,26004,CARPE DIEM,2026-05-15,60000,0,3000',
    'F-4000,25007,CONSEIL DE LA NATION ATIKAMEKW,2025-05-31,500000,0,0', // hors période
  ].join('\n');

  const contra = [
    'CONUM,CONOM,COCLINOM,COSTT',
    '25007,TV-18 Atikamekw maison de transition,CONSEIL DE LA NATION ATIKAMEKW,A',
    '26004,BD-50 Eglise du Tres-Saint-Sacrement,CARPE DIEM,A',
  ].join('\n');

  const active = ['en-tete', '06100,Charpenterie,Carpentry', '00400,Conditions generales,General'].join('\n');
  const comite = ['en-tete'].concat(['x,,,,,,,,,,,,,,,,000002087,06100']).join('\n');

  fs.writeFileSync(path.join(DIR, 'PYBBIL.csv'), pybbil, 'latin1');
  fs.writeFileSync(path.join(DIR, 'TRANS.csv'), trans, 'latin1');
  fs.writeFileSync(path.join(DIR, 'FACTMA.csv'), factma, 'latin1');
  fs.writeFileSync(path.join(DIR, 'CONTRA.csv'), contra, 'latin1');
  fs.writeFileSync(path.join(DIR, 'ACTIVE.csv'), active, 'latin1');
  fs.writeFileSync(path.join(DIR, 'COMITE.csv'), comite, 'latin1');
}

// ------------------------------------------------------------------ exécution
(async () => {
  ecrireFixtures();
  const cx = require('../src/db/connexion');
  const etatResultats = require('../src/services/etatResultats');
  const { classer } = require('../src/config/plan-comptable');

  console.log('\nGarde-fou lecture seule');
  for (const sql of [
    'UPDATE PYBBIL SET PBMT01 = 0',
    'DELETE FROM TRANS',
    'DROP TABLE FACTMA',
    'INSERT INTO CONTRA VALUES (1)',
    'select * from PYBBIL; delete from PYBBIL',
  ]) {
    await test('refuse : ' + sql.slice(0, 42), async () => {
      let rejete = false;
      try { await cx.interroger(sql); } catch (e) { rejete = true; }
      assert.ok(rejete, 'la requête aurait dû être refusée');
    });
  }

  // Régression : le suffixe de sous-projet doit survivre à la normalisation.
  // Sans lui, « 00003006-1 » et « 0000003006 » se confondaient et les revenus de deux
  // projets distincts s'additionnaient sur une seule ligne, sans aucun signe visible.
  console.log('\nNormalisation des numéros de projet');
  const { normaliserProjet } = require('../src/parsers/parseGrandLivre');
  for (const [entree, attendu] of [
    ['0000025007', '25007'],
    ['00003006-1', '03006-1'],
    ['0000003006', '03006'],
    ['25007', '25007'],
    ['', ''],
    ['0000000000', ''],
    ['   ', ''],
  ]) {
    await test('« ' + entree + ' » → « ' + attendu + ' »', () => {
      assert.strictEqual(normaliserProjet(entree), attendu);
    });
  }
  await test('un sous-projet ne se confond pas avec son projet parent', () => {
    assert.notStrictEqual(normaliserProjet('00003006-1'), normaliserProjet('0000003006'));
  });

  // Régression : le parseur cherchait les colonnes CONUM/CONOM, absentes de l'export réel,
  // qui porte des intitulés français. Résultat : zéro projet nommé, et un drill-down qui
  // n'affichait que des numéros.
  console.log('\nFiches de projet (CONTRA)');
  const { parseContraProjets } = require('../src/parsers/parseGrandLivre');

  await test('lit les intitulés français de l\'export réel', () => {
    const csv = 'Numéro du projet,Description du projet (1),Description du projet (2),' +
      'Date de début du projet,Date de fin du projet,Numéro du client\n' +
      '0000025007,Agrandissement usine,,2025/08/01,,C0042\n' +
      '0000003006,Service après vente,,2003/01/01,,\n';
    const m = parseContraProjets(csv);
    assert.strictEqual(m['25007'].nom, 'Agrandissement usine');
    assert.strictEqual(m['25007'].client, 'C0042');
    assert.strictEqual(m['03006'].nom, 'Service après vente');
  });

  await test('lit encore les anciens exports à codes courts', () => {
    const csv = 'CONUM,CONOM,COCLINOM\n0000025007,Agrandissement usine,KRUGER\n';
    const m = parseContraProjets(csv);
    assert.strictEqual(m['25007'].nom, 'Agrandissement usine');
    assert.strictEqual(m['25007'].client, 'KRUGER');
  });

  await test('un export vide ne fait pas planter la lecture', () => {
    assert.deepStrictEqual(parseContraProjets(''), {});
    assert.deepStrictEqual(parseContraProjets('Numéro du projet,Description du projet (1)\n'), {});
  });

  console.log('\nClassification');
  await test('sous-traitance de projet reconnue', () => {
    assert.strictEqual(classer('33500', 'GROUPE JLF', true).poste, 'sous_traitance');
  });
  await test('GL de projet hors projet reclassé en frais général', () => {
    assert.strictEqual(classer('33200', 'AVIVA ASSURANCE', false).poste, 'assurances');
  });
  await test('fournisseur sans GL classé par mot-clé', () => {
    assert.strictEqual(classer('', 'MALLETTE S.E.N.C.R.L.', false).poste, 'honoraires');
  });
  await test('GL inconnu hors projet exposé dans À classer', () => {
    assert.strictEqual(classer('99999', 'FOURNISSEUR MYSTERE', false).poste, 'a_classer');
  });

  console.log('\nÉtat des résultats — période 2026-01-01 au 2026-07-31');
  const etat = await etatResultats.construire('2026-01-01', '2026-07-31');

  await test('lecture seule affirmée dans la réponse', () => {
    assert.strictEqual(etat.lecture_seule, true);
  });

  await test('revenus = 300 000 $ (hors période exclu)', () => {
    assert.strictEqual(etat.totaux.revenus, 300000);
  });

  await test('taxes exclues du coût des matériaux', () => {
    const mat = trouver(etat, 'cout_direct', 'materiaux');
    // 10 000 (Boulay, taxes retirées) + 3 000 (Raydan) = 13 000
    assert.strictEqual(mat.total, 13000);
  });

  await test('main-d\'oeuvre de projet = 28 000 $', () => {
    const mo = trouver(etat, 'cout_direct', 'mo_directe');
    assert.strictEqual(mo.total, 28000); // 20 000 + 8 000, le salaire sans projet est exclu
  });

  await test('salaire sans projet reclassé en frais de structure', () => {
    const s = trouver(etat, 'frais_general', 'salaires_struct');
    assert.strictEqual(s.total, 12000);
  });

  await test('marge brute = revenus − coût des travaux', () => {
    const cd = etat.sections.find(s => s.id === 'cout_direct').total;
    assert.strictEqual(etat.totaux.marge_brute, Math.round((300000 - cd) * 100) / 100);
  });

  await test('résultat net = marge brute − frais généraux − à classer', () => {
    const t = etat.totaux;
    assert.strictEqual(t.resultat_net,
      Math.round((t.marge_brute - t.frais_generaux - t.non_classe) * 100) / 100);
  });

  await test('aucune charge perdue : somme des sections = somme des lignes lues', () => {
    const totalSections = etat.sections.reduce((s, x) => s + x.total, 0);
    // Toutes les lignes de charge de la période, taxes déjà exclues au parsing.
    const attendu = 50000 + 10000 + 3000 + 18225 + 2629.52 + 605.04 + 1500  // PYBBIL
                  + 20000 + 5000 + 8000 + 12000 + 1234;                      // TRANS
    assert.strictEqual(Math.round(totalSections * 100) / 100, Math.round(attendu * 100) / 100);
  });

  await test('drill-down réconcilié à chaque niveau', () => {
    for (const s of etat.sections) {
      let sommePostes = 0;
      for (const p of s.postes) {
        let sommeComptes = 0;
        for (const c of p.comptes) {
          let sommeFourn = 0;
          for (const f of c.fournisseurs) {
            const sommeFactures = f.factures.reduce((a, x) => a + x.montant, 0);
            assert.ok(Math.abs(sommeFactures - f.total) < 0.02,
              'fournisseur ' + f.nom + ' : factures ' + sommeFactures + ' ≠ total ' + f.total);
            sommeFourn += f.total;
          }
          assert.ok(Math.abs(sommeFourn - c.total) < 0.02, 'compte ' + c.gl + ' non réconcilié');
          sommeComptes += c.total;
        }
        assert.ok(Math.abs(sommeComptes - p.total) < 0.02, 'poste ' + p.id + ' non réconcilié');
        sommePostes += p.total;
      }
      assert.ok(Math.abs(sommePostes - s.total) < 0.02, 'section ' + s.id + ' non réconciliée');
    }
  });

  await test('revenus réconciliés avec le détail par facture', () => {
    const somme = etat.revenus.projets.reduce((a, p) =>
      a + p.factures.reduce((b, f) => b + f.montant, 0), 0);
    assert.strictEqual(Math.round(somme * 100) / 100, etat.totaux.revenus);
  });

  await test('solde ouvert remonté (90 000 $)', () => {
    assert.strictEqual(etat.revenus.solde_ouvert, 90000);
  });

  await test('division CSI déduite du numéro de commande', () => {
    const st = trouver(etat, 'cout_direct', 'sous_traitance');
    const f = st.comptes[0].fournisseurs[0].factures[0];
    assert.strictEqual(f.division, '06100');
    assert.strictEqual(f.divisionNom, 'Charpenterie');
  });

  await test('GL non mappés listés pour correction', () => {
    const gls = etat.qualite.gl_a_mapper.map(g => g.gl);
    assert.ok(gls.includes('99999'), 'le GL 99999 doit être signalé');
    assert.ok(etat.qualite.montant_non_classe > 0);
  });

  await test('nom de projet résolu depuis CONTRA', () => {
    const p = etat.revenus.projets.find(x => x.projet === '25007');
    assert.ok(p.nom.includes('Atikamekw'), 'nom obtenu : ' + p.nom);
  });

  await test('provenance des données tracée', () => {
    assert.strictEqual(etat.provenance.revenus.mode, 'csv');
    assert.strictEqual(etat.provenance.charges_fournisseurs.mode, 'csv');
  });

  await test('annualisation cohérente avec la durée', () => {
    const m = etat.periode.mois;
    assert.ok(m > 6.5 && m < 7.5, 'mois calculés : ' + m);
    assert.strictEqual(etat.annualise.revenus, Math.round(300000 / m * 12 * 100) / 100);
  });

  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(echecs ? 1 : 0);
})();

function trouver(etat, idSection, idPoste) {
  const s = etat.sections.find(x => x.id === idSection);
  assert.ok(s, 'section absente : ' + idSection);
  const p = s.postes.find(x => x.id === idPoste);
  assert.ok(p, 'poste absent : ' + idPoste + ' dans ' + idSection +
    ' (présents : ' + s.postes.map(x => x.id).join(', ') + ')');
  return p;
}
