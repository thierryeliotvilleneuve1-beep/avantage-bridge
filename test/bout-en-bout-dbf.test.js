// Contrôle de bout en bout : des fichiers .DBF jusqu'à l'état des résultats.
//
// Lancer :  npm run test:bout-en-bout
//
// C'est le test qui compte. Il fabrique un jeu complet de tables Avantage au format .DBF,
// avec la même disposition de colonnes que la base réelle, puis vérifie que le bridge :
//   1. résout seul les noms de champs — par position pour PYBBIL/TRANS, par nom pour
//      FACTMA/CONTRA dont les intitulés sont connus ;
//   2. lit les enregistrements et écarte les supprimés ;
//   3. sépare les coûts de projet des frais généraux ;
//   4. produit un état des résultats dont chaque total est exact.
//
// Aucun export CSV, aucun ODBC : uniquement les .DBF.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-bout-'));
// Isole complètement : pas de CSV de repli, pas de base ODBC.
process.env.AVANTAGE_DBF_DIR = DIR;
process.env.AVANTAGE_EXPORT_DIR = path.join(DIR, 'aucun-export');
process.env.AVANTAGE_BD_ACTIVE = 'false';

let reussis = 0, echecs = 0;
async function test(nom, fn) {
  try { await fn(); reussis++; console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.log('  ÉCHEC ' + nom + '\n         ' + e.message); }
}

// ── Fabrique de .DBF ────────────────────────────────────────────────────────────
const aide = require('./aide-dbf');
const ecrireDbf = aide.pour(DIR);
const champsPybbil = aide.champsPybbil;
const lignePybbil = aide.lignePybbil;

function ecrireJeu() {
  // ── PYBBIL : coûts de projet, frais généraux, taxes, note de crédit, supprimé
  ecrireDbf('PYBBIL.DBF', champsPybbil(), [
    // Sous-traitance de projet : 300 000 $
    lignePybbil({ seq: '1001', date: '20260210', noFourn: 'F01', facture: 'ST-1', desc: 'Charpente',
      total: '300000.00', projet: '0000025007', commande: '000002087',
      nom: 'GROUPE JLF CONSTRUCTION INC.', gl: [['33500', '300000.00']] }),
    // Matériaux avec taxes : seuls les 40 000 $ hors taxes doivent compter
    lignePybbil({ seq: '1002', date: '20260312', noFourn: 'F02', facture: 'MT-1', desc: 'Acier',
      total: '45990.00', projet: '0000026004', nom: 'BOULAY INOX INC.',
      gl: [['33200', '40000.00'], ['21300', '2000.00'], ['21340', '3990.00']] }),
    // Enregistrement supprimé : ne doit jamais compter
    lignePybbil({ seq: '1003', date: '20260313', noFourn: 'F03', facture: 'ANNULE', desc: 'Annule',
      total: '888888.00', projet: '0000025007', nom: 'NE DOIT PAS APPARAITRE',
      gl: [['33500', '888888.00']], supprime: true }),
    // Frais général : aucun projet, GL informatique
    lignePybbil({ seq: '2001', date: '20260120', noFourn: 'G01', facture: 'FG-1', desc: 'Informatique',
      total: '50000.00', nom: 'BLACKWARE TECHNOLOGIES INC.', gl: [['42120', '50000.00']] }),
    // Frais général : honoraires
    lignePybbil({ seq: '2002', date: '20260405', noFourn: 'G02', facture: 'FG-2', desc: 'Honoraires',
      total: '20000.00', nom: 'MALLETTE S.E.N.C.R.L.', gl: [['42101', '20000.00']] }),
    // Note de crédit fournisseur : montant négatif sur un frais général
    lignePybbil({ seq: '2003', date: '20260406', noFourn: 'G02', facture: 'CR-1', desc: 'Credit',
      total: '-5000.00', nom: 'MALLETTE S.E.N.C.R.L.', gl: [['42101', '-5000.00']] }),
    // Mouvement de bilan : compte d'actif, hors résultat
    lignePybbil({ seq: '2004', date: '20260407', noFourn: 'G03', facture: 'ASSUR', desc: 'Assurances',
      total: '30000.00', nom: 'AVIVA ASSURANCE', gl: [['11145', '30000.00']] }),
    // Hors période
    lignePybbil({ seq: '9001', date: '20250101', noFourn: 'F01', facture: 'VIEUX', desc: 'Ancien',
      total: '777777.00', projet: '0000025007', nom: 'GROUPE JLF CONSTRUCTION INC.',
      gl: [['33500', '777777.00']] }),
  ]);

  // ── TRANS : positions 0..5
  ecrireDbf('TRANS.DBF', [
    { nom: 'TRPROJ', type: 'C', longueur: 10 },
    { nom: 'TRGL', type: 'C', longueur: 5 },
    { nom: 'TRDATE', type: 'D', longueur: 8 },
    { nom: 'TRJRNL', type: 'C', longueur: 10 },
    { nom: 'TRMNT', type: 'N', longueur: 13, decimales: 2 },
    { nom: 'TRACT', type: 'C', longueur: 10 },
  ], [
    // Main-d'oeuvre de projet : 100 000 $
    { TRPROJ: '0000025007', TRGL: '34100', TRDATE: '20260301', TRJRNL: 'E00101', TRMNT: '100000.00', TRACT: '06100' },
    // Salaire sans projet : reclassé en frais de structure, 80 000 $
    { TRPROJ: '', TRGL: '43100', TRDATE: '20260201', TRJRNL: 'E00102', TRMNT: '80000.00', TRACT: '' },
    // Type ignoré : ni E ni B
    { TRPROJ: '0000025007', TRGL: '34100', TRDATE: '20260302', TRJRNL: 'X00103', TRMNT: '55555.00', TRACT: '06100' },
    // Hors période
    { TRPROJ: '0000025007', TRGL: '34100', TRDATE: '20250301', TRJRNL: 'E00001', TRMNT: '444444.00', TRACT: '06100' },
  ]);

  // ── FACTMA : noms connus, donc résolus par nom et non par position
  ecrireDbf('FACTMA.DBF', [
    { nom: 'FFNOFACT', type: 'C', longueur: 10 },
    { nom: 'FFCONT', type: 'C', longueur: 10 },
    { nom: 'FFVENTE', type: 'C', longueur: 40 },
    { nom: 'FFDATE', type: 'D', longueur: 8 },
    { nom: 'FFTOTDU', type: 'N', longueur: 13, decimales: 2 },
    { nom: 'FFSOLDE', type: 'N', longueur: 13, decimales: 2 },
    { nom: 'FFMNTRET', type: 'N', longueur: 13, decimales: 2 },
    { nom: 'FFNOTCR', type: 'L', longueur: 1 },
  ], [
    { FFNOFACT: 'F-001', FFCONT: '0000025007', FFVENTE: 'CONSEIL DE LA NATION ATIKAMEKW',
      FFDATE: '20260331', FFTOTDU: '700000.00', FFSOLDE: '0.00', FFMNTRET: '35000.00', FFNOTCR: 'F' },
    { FFNOFACT: 'F-002', FFCONT: '0000026004', FFVENTE: 'CARPE DIEM',
      FFDATE: '20260430', FFTOTDU: '200000.00', FFSOLDE: '200000.00', FFMNTRET: '10000.00', FFNOTCR: 'F' },
    // Note de crédit client : vient en diminution du revenu
    { FFNOFACT: 'F-003', FFCONT: '0000025007', FFVENTE: 'CONSEIL DE LA NATION ATIKAMEKW',
      FFDATE: '20260501', FFTOTDU: '50000.00', FFSOLDE: '0.00', FFMNTRET: '0.00', FFNOTCR: 'T' },
    // Hors période
    { FFNOFACT: 'F-900', FFCONT: '0000025007', FFVENTE: 'CONSEIL DE LA NATION ATIKAMEKW',
      FFDATE: '20250301', FFTOTDU: '999999.00', FFSOLDE: '0.00', FFMNTRET: '0.00', FFNOTCR: 'F' },
  ]);

  ecrireDbf('CONTRA.DBF', [
    { nom: 'CONUM', type: 'C', longueur: 10 },
    { nom: 'CONOM', type: 'C', longueur: 40 },
    { nom: 'COCLINOM', type: 'C', longueur: 40 },
    { nom: 'COSTT', type: 'C', longueur: 2 },
  ], [
    { CONUM: '0000025007', CONOM: 'TV-18 Atikamekw maison de transition', COCLINOM: 'CONSEIL DE LA NATION ATIKAMEKW', COSTT: 'A' },
    { CONUM: '0000026004', CONOM: 'BD-50 Eglise du Tres-Saint-Sacrement', COCLINOM: 'CARPE DIEM', COSTT: 'A' },
  ]);

  ecrireDbf('ACTIVE.DBF', [
    { nom: 'ACNUM', type: 'C', longueur: 10 },
    { nom: 'ACDESC', type: 'C', longueur: 40 },
  ], [
    { ACNUM: '06100', ACDESC: 'Charpenterie' },
    { ACNUM: '00400', ACDESC: 'Conditions generales' },
  ]);

  // COMITE : positions 16 et 17
  const champsComite = [];
  for (let i = 0; i < 18; i++) {
    champsComite.push(i === 16
      ? { nom: 'CMCMD', type: 'C', longueur: 9 }
      : (i === 17 ? { nom: 'CMACT', type: 'C', longueur: 10 } : { nom: 'CMF' + i, type: 'C', longueur: 4 }));
  }
  ecrireDbf('COMITE.DBF', champsComite, [
    { CMCMD: '000002087', CMACT: '06100' },
  ]);
}

// ── Exécution ───────────────────────────────────────────────────────────────────
(async () => {
  ecrireJeu();

  const source = require('../src/sources/donneesAvantage');
  const etatResultats = require('../src/services/etatResultats');
  const { estLisibleEnBd } = require('../src/config/colonnes-avantage');

  console.log('\nRésolution automatique des champs');
  const mappage = await source.autoMapper(true);
  const parTable = {};
  mappage.forEach(m => { parTable[m.table] = m; });

  for (const t of ['PYBBIL', 'TRANS', 'FACTMA', 'CONTRA', 'ACTIVE', 'COMITE']) {
    await test(t + ' est résolue et validée', () => {
      const m = parTable[t];
      assert.ok(m, t + ' absente du rapport de mappage');
      assert.ok(m.retenu, 'refusée : ' + m.raison);
      assert.strictEqual(estLisibleEnBd(t), true);
    });
  }

  await test('PYBBIL est résolue par position', () => {
    const m = parTable.PYBBIL;
    assert.strictEqual(m.mappage.date, 'PBDATE', 'index 1');
    assert.strictEqual(m.mappage.montantTotal, 'PBTOTAL', 'index 6');
    assert.strictEqual(m.mappage.nomFournisseur, 'PBNOMFOU', 'index 48');
    assert.strictEqual(m.strategies.date, 'position');
  });

  await test('les dix paires GL de PYBBIL sont retrouvées', () => {
    const m = parTable.PYBBIL;
    assert.strictEqual(m.paires.length, 10);
    assert.deepStrictEqual(m.paires[0], { gl: 'PBGL01', montant: 'PBMT01' });
  });

  await test('FACTMA est résolue par nom, pas par position', () => {
    const m = parTable.FACTMA;
    assert.strictEqual(m.mappage.numeroFacture, 'FFNOFACT');
    assert.strictEqual(m.mappage.montant, 'FFTOTDU');
    assert.strictEqual(m.strategies.numeroFacture, 'nom');
  });

  console.log('\nÉtat des résultats lu uniquement dans les .DBF');
  const e = await etatResultats.construire('2026-01-01', '2026-12-31');
  const t = e.totaux;

  await test('toutes les données viennent des .DBF', () => {
    assert.strictEqual(e.provenance.revenus.mode, 'dbf', JSON.stringify(e.provenance.revenus));
    assert.strictEqual(e.provenance.charges_fournisseurs.mode, 'dbf');
    assert.strictEqual(e.provenance.ecritures.mode, 'dbf');
    assert.strictEqual(e.provenance.projets.mode, 'dbf');
  });

  await test('revenus = 850 000 $ (900 000 moins la note de crédit de 50 000)', () => {
    assert.strictEqual(t.revenus, 850000);
  });

  await test('la facture hors période est exclue', () => {
    assert.ok(!e.revenus.projets.some(p => p.factures.some(f => f.numeroFacture === 'F-900')));
  });

  await test('solde ouvert = 200 000 $', () => {
    assert.strictEqual(e.revenus.solde_ouvert, 200000);
  });

  await test('le nom du projet vient de CONTRA.DBF', () => {
    const p = e.revenus.projets.find(x => x.projet === '25007');
    assert.ok(/Atikamekw/.test(p.nom), 'obtenu : ' + p.nom);
  });

  const poste = (idSection, idPoste) => {
    const s = e.sections.find(x => x.id === idSection);
    assert.ok(s, 'section absente : ' + idSection);
    const p = s.postes.find(x => x.id === idPoste);
    assert.ok(p, 'poste absent : ' + idPoste + ' — présents : ' + s.postes.map(x => x.id).join(', '));
    return p;
  };

  await test('sous-traitance = 300 000 $, le supprimé écarté', () => {
    assert.strictEqual(poste('cout_direct', 'sous_traitance').total, 300000);
  });

  await test('matériaux = 40 000 $, taxes exclues', () => {
    assert.strictEqual(poste('cout_direct', 'materiaux').total, 40000);
  });

  await test('main-d\'oeuvre de projet = 100 000 $', () => {
    assert.strictEqual(poste('cout_direct', 'mo_directe').total, 100000);
  });

  await test('salaire sans projet reclassé en structure = 80 000 $', () => {
    assert.strictEqual(poste('frais_general', 'salaires_struct').total, 80000);
  });

  await test('informatique = 50 000 $', () => {
    assert.strictEqual(poste('frais_general', 'telecom_info').total, 50000);
  });

  await test('honoraires = 15 000 $ après la note de crédit', () => {
    assert.strictEqual(poste('frais_general', 'honoraires').total, 15000);
  });

  await test('les assurances payées d\'avance sortent du résultat', () => {
    assert.strictEqual(poste('bilan', 'assurances_payees_davance').total, 30000);
    assert.strictEqual(t.mouvements_bilan, 30000);
  });

  await test('marge brute = 850 000 − 440 000 = 410 000 $', () => {
    assert.strictEqual(t.cout_direct, 440000);
    assert.strictEqual(t.marge_brute, 410000);
  });

  await test('résultat net = 410 000 − 145 000 = 265 000 $', () => {
    assert.strictEqual(t.frais_generaux, 145000);
    assert.strictEqual(t.non_classe, 0);
    assert.strictEqual(t.resultat_net, 265000);
  });

  await test('aucune charge non classée', () => {
    assert.strictEqual(e.qualite.pct_non_classe, 0, JSON.stringify(e.qualite.gl_a_mapper));
  });

  await test('la division CSI vient de COMITE.DBF et ACTIVE.DBF', () => {
    const st = poste('cout_direct', 'sous_traitance');
    const f = st.comptes[0].fournisseurs[0].factures[0];
    assert.strictEqual(f.division, '06100');
    assert.strictEqual(f.divisionNom, 'Charpenterie');
  });

  await test('le drill-down se réconcilie à chaque niveau', () => {
    for (const s of e.sections) {
      let sp = 0;
      for (const p of s.postes) {
        let sc = 0;
        for (const c of p.comptes) {
          let sf = 0;
          for (const f of c.fournisseurs) {
            const sfact = f.factures.reduce((a, x) => a + x.montant, 0);
            assert.ok(Math.abs(sfact - f.total) < 0.02, f.nom + ' : ' + sfact + ' ≠ ' + f.total);
            sf += f.total;
          }
          assert.ok(Math.abs(sf - c.total) < 0.02, 'compte ' + c.gl);
          sc += c.total;
        }
        assert.ok(Math.abs(sc - p.total) < 0.02, 'poste ' + p.id);
        sp += p.total;
      }
      assert.ok(Math.abs(sp - s.total) < 0.02, 'section ' + s.id);
    }
  });

  await test('le diagnostic annonce la voie DBF et la fraîcheur', () => {
    const s = source.etatSources();
    assert.strictEqual(s.voie_retenue, 'dbf');
    assert.ok(s.fichiers_dbf.tables.PYBBIL.present);
    assert.ok(s.fichiers_dbf.tables.PYBBIL.nb_enregistrements >= 8);
    assert.ok(s.fichiers_dbf.tables.PYBBIL.modifie, 'la date de modification doit être exposée');
    assert.strictEqual(s.tables_a_resoudre.length, 0, 'reste : ' + s.tables_a_resoudre.join(', '));
  });

  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(echecs ? 1 : 0);
})().catch(e => {
  console.error('Échec du harnais : ' + e.message + '\n' + e.stack);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
