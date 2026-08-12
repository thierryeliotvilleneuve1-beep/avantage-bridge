// Contrôle de la déduction automatique des colonnes.
//
// Lancer :  npm run test:mappage
//
// La base Avantage n'est pas joignable depuis un poste de développement, et encore moins
// depuis un serveur d'intégration. On simule donc le pilote ODBC : un faux dépôt qui
// retourne une liste de colonnes et un échantillon de lignes. C'est suffisant pour
// vérifier ce qui compte vraiment — que le mappage par position soit correct, et surtout
// que la validation REFUSE un mappage faux au lieu de produire des chiffres inventés.

const assert = require('assert');
const auto = require('../src/db/autoMappage');
const { TABLES, estLisibleEnBd } = require('../src/config/colonnes-avantage');

let reussis = 0, echecs = 0;
async function test(nom, fn) {
  try { await fn(); reussis++; console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.log('  ÉCHEC ' + nom + '\n         ' + e.message); }
}

// ── Faux pilote ─────────────────────────────────────────────────────────────────
// Fabrique une table de `n` colonnes nommées PB001..PBnnn, et des lignes dont le contenu
// est posé aux index que le bridge attend pour PYBBIL.
function depotPybbil(options) {
  const o = options || {};
  const nbCol = o.nbColonnes === undefined ? 49 : o.nbColonnes;
  const noms = Array.from({ length: nbCol }, (_, i) => 'PB' + String(i + 1).padStart(3, '0'));

  const lignes = [];
  for (let k = 0; k < (o.nbLignes || 50); k++) {
    const l = {};
    noms.forEach(n => { l[n] = ''; });
    l[noms[0]] = String(1000 + k);
    l[noms[1]] = o.datesCassees ? 'pas une date' : '2026-0' + ((k % 9) + 1) + '-14';
    l[noms[2]] = 'F' + k;
    l[noms[4]] = 'FACT-' + k;
    l[noms[5]] = 'Description ' + k;
    l[noms[6]] = o.montantsCasses ? 'abc' : String(1000 + k * 7.5);
    if (nbCol > 33) l[noms[33]] = o.projetsCasses ? 'PROJET-X!' : String(25000 + (k % 30));
    if (nbCol > 44) l[noms[44]] = String(2000 + k);
    if (nbCol > 48) l[noms[48]] = 'FOURNISSEUR ' + (k % 12);
    if (nbCol > 9) { l[noms[8]] = o.glCasses ? 'zzz' : '33500'; l[noms[9]] = String(500 + k); }
    if (nbCol > 11) { l[noms[10]] = '33200'; l[noms[11]] = String(120 + k); }
    lignes.push(l);
  }

  return {
    listerColonnes: async () => noms.map((n, i) => ({ position: i + 1, nom: n, type: 'CHAR' })),
    echantillonner: async () => (o.tableVide ? [] : lignes),
  };
}

function depotTrans(options) {
  const o = options || {};
  const noms = ['TRPROJ', 'TRGL', 'TRDATE', 'TRJRNL', 'TRMNT', 'TRACT'];
  const lignes = [];
  for (let k = 0; k < 40; k++) {
    lignes.push({
      TRPROJ: String(25000 + (k % 10)),
      TRGL: '34100',
      TRDATE: '2026-03-' + String((k % 28) + 1).padStart(2, '0'),
      TRJRNL: (o.journalCasse ? '12345' : 'E') + String(500 + k),
      TRMNT: String(2000 + k * 3),
      TRACT: '06100',
    });
  }
  return {
    listerColonnes: async () => noms.map((n, i) => ({ position: i + 1, nom: n })),
    echantillonner: async () => lignes,
  };
}

// Remet la configuration dans son état d'origine entre les cas.
function reinitialiser(nomTable) {
  const def = TABLES[nomTable];
  Object.values(def.colonnes).forEach(c => { if (typeof c.csv === 'number') c.bd = null; });
  if (def.pairesGl) def.pairesGl.bd = null;
  def.mappe = ['FACTMA', 'CONTRA'].includes(nomTable);
}

(async () => {
  console.log('\nMappage par position');

  await test('PYBBIL : les neuf champs sont associés aux bonnes colonnes', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil());
    assert.ok(r.retenu, 'refusé : ' + r.raison);
    assert.strictEqual(r.mappage.date, 'PB002', 'index CSV 1 -> 2e colonne');
    assert.strictEqual(r.mappage.numeroProjet, 'PB034', 'index CSV 33 -> 34e colonne');
    assert.strictEqual(r.mappage.nomFournisseur, 'PB049', 'index CSV 48 -> 49e colonne');
    assert.strictEqual(r.mappage.montantTotal, 'PB007');
  });

  await test('PYBBIL : les dix paires GL sont reconstituées', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil());
    assert.strictEqual(r.paires.length, 10, 'dix paires attendues');
    assert.deepStrictEqual(r.paires[0], { gl: 'PB009', montant: 'PB010' });
    assert.deepStrictEqual(r.paires[9], { gl: 'PB027', montant: 'PB028' });
  });

  await test('TRANS : les six champs sont associés', async () => {
    reinitialiser('TRANS');
    const r = await auto.deduire('TRANS', depotTrans());
    assert.ok(r.retenu, 'refusé : ' + r.raison);
    assert.strictEqual(r.mappage.numeroProjet, 'TRPROJ');
    assert.strictEqual(r.mappage.journal, 'TRJRNL');
    assert.strictEqual(r.mappage.montant, 'TRMNT');
  });

  console.log('\nLa validation refuse ce qui ne tient pas');

  await test('refuse quand les dates ne sont pas des dates', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ datesCassees: true }));
    assert.strictEqual(r.retenu, false, 'aurait dû être refusé');
    assert.ok(/date/.test(r.raison), 'la raison doit nommer le champ date : ' + r.raison);
  });

  await test('refuse quand les montants ne sont pas numériques', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ montantsCasses: true }));
    assert.strictEqual(r.retenu, false);
    assert.ok(/montantTotal/.test(r.raison), r.raison);
  });

  await test('refuse quand les numéros de projet sont aberrants', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ projetsCasses: true }));
    assert.strictEqual(r.retenu, false);
    assert.ok(/numeroProjet/.test(r.raison), r.raison);
  });

  await test('refuse quand un champ OBLIGATOIRE est hors des colonnes de la table', async () => {
    reinitialiser('PYBBIL');
    // 20 colonnes : numeroProjet, attendu en 33, n'existe pas.
    const r = await auto.deduire('PYBBIL', depotPybbil({ nbColonnes: 20 }));
    assert.strictEqual(r.retenu, false);
    assert.ok(/obligatoire/.test(r.raison), r.raison);
    assert.ok(/numeroProjet/.test(r.raison), r.raison);
    assert.ok(Array.isArray(r.colonnes_reelles), 'doit lister les colonnes réelles pour dépanner');
  });

  // Régression : un champ FACULTATIF introuvable faisait renoncer à toute la table. Sur la
  // vraie base, CONTRA tombait en entier parce que le nom du client et le statut, deux
  // colonnes de pur affichage, n'existaient pas — et le drill-down perdait 1 292 projets.
  await test('un champ facultatif introuvable ne condamne pas la table', async () => {
    reinitialiser('PYBBIL');
    // 40 colonnes : numeroCommande (44) et nomFournisseur (48) manquent, tous deux facultatifs.
    const r = await auto.deduire('PYBBIL', depotPybbil({ nbColonnes: 40 }));
    assert.strictEqual(r.retenu, true, 'refusé à tort : ' + r.raison);
    assert.ok(r.champs_facultatifs_absents.length >= 2, JSON.stringify(r.champs_facultatifs_absents));
    assert.ok(/nomFournisseur/.test(r.champs_facultatifs_absents.join(' ')));
    assert.strictEqual(r.mappage.nomFournisseur, undefined, 'ne doit pas inventer de colonne');
  });

  await test('la table reste lisible malgré un champ facultatif manquant', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ nbColonnes: 40 }));
    assert.strictEqual(auto.appliquer(r), true);
    assert.strictEqual(estLisibleEnBd('PYBBIL'), true,
      'les champs obligatoires sont résolus, la table doit être lisible');
    assert.strictEqual(TABLES.PYBBIL.colonnes.nomFournisseur.bd, null);
    reinitialiser('PYBBIL');
  });

  await test('refuse quand la table est vide — rien à valider', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ tableVide: true }));
    assert.strictEqual(r.retenu, false);
    assert.ok(/vide/.test(r.raison), r.raison);
  });

  await test('refuse quand le journal TRANS ne commence pas par une lettre', async () => {
    reinitialiser('TRANS');
    const r = await auto.deduire('TRANS', depotTrans({ journalCasse: true }));
    assert.strictEqual(r.retenu, false);
    assert.ok(/journal/.test(r.raison), r.raison);
  });

  await test('signale une introspection impossible sans planter', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', {
      listerColonnes: async () => { throw new Error('pilote ODBC absent'); },
      echantillonner: async () => [],
    });
    assert.strictEqual(r.retenu, false);
    assert.ok(/introspection/.test(r.raison), r.raison);
  });

  await test('un GL incohérent n\'invalide pas tout le mappage', async () => {
    // Les paires GL sont vérifiées, mais une seule paire douteuse ne doit pas faire
    // perdre l'accès à la table : le repli sur le montant total reste possible.
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ glCasses: true }));
    assert.ok(r.controles.paire_gl_1, 'la paire doit être contrôlée');
    assert.strictEqual(r.retenu, true, 'refusé alors que les champs obligatoires tiennent : ' + r.raison);
  });

  console.log('\nColonne entièrement vide : indécidable, pas incohérent');

  // Régression : une colonne vide sur tout l'échantillon était comptée comme un échec,
  // au même titre qu'une colonne au contenu franchement faux. Un champ légitimement
  // inutilisé faisait donc refuser le mappage de toute la table.
  const vides = [{ P: '' }, { P: '' }, { P: '   ' }];

  await test('colonne vide acceptée quand elle a été trouvée par son nom', async () => {
    const v = auto.valider('PYBBIL', { numeroProjet: 'P' }, null, vides,
      { numeroProjet: 'nom' });
    assert.strictEqual(v.valide, true, v.echecs.join(' | '));
    assert.ok(/accept/.test(v.details.numeroProjet.verdict),
      'le verdict doit dire que le vide est accepté : ' + v.details.numeroProjet.verdict);
  });

  await test('colonne vide toujours refusée quand elle vient d\'une position', async () => {
    // Ici le vide est le seul indice qu'on pourrait viser la mauvaise colonne.
    const v = auto.valider('PYBBIL', { numeroProjet: 'P' }, null, vides,
      { numeroProjet: 'position' });
    assert.strictEqual(v.valide, false, 'le vide positionnel doit rester un échec');
  });

  await test('une date vide reste un échec même trouvée par son nom', async () => {
    // La nature « date » ne tolère pas le vide : sans date, aucune période n'est calculable.
    const v = auto.valider('PYBBIL', { date: 'P', montantTotal: 'M' },
      null, [{ P: '', M: '100' }, { P: '', M: '200' }], { date: 'nom', montantTotal: 'nom' });
    assert.strictEqual(v.valide, false);
    assert.ok(/date/.test(v.echecs.join(' ')), v.echecs.join(' '));
  });

  await test('sans stratégies fournies, le contrôle reste le plus strict', async () => {
    const v = auto.valider('PYBBIL', { numeroProjet: 'P' }, null, vides);
    assert.strictEqual(v.valide, false);
  });

  await test('une colonne vide ne masque pas un contenu incohérent ailleurs', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ datesCassees: true }));
    assert.strictEqual(r.retenu, false, 'une date fausse doit toujours faire échouer');
  });

  console.log('\nApplication du mappage retenu');

  await test('appliquer renseigne la configuration et rend la table lisible', async () => {
    reinitialiser('PYBBIL');
    assert.strictEqual(estLisibleEnBd('PYBBIL'), false, 'devrait partir non mappée');
    const r = await auto.deduire('PYBBIL', depotPybbil());
    assert.strictEqual(auto.appliquer(r), true);
    assert.strictEqual(TABLES.PYBBIL.colonnes.numeroProjet.bd, 'PB034');
    assert.deepStrictEqual(TABLES.PYBBIL.pairesGl.bd[0], { gl: 'PB009', montant: 'PB010' });
    assert.strictEqual(estLisibleEnBd('PYBBIL'), true, 'devrait être lisible après application');
    reinitialiser('PYBBIL');
  });

  await test('appliquer refuse un mappage non retenu', async () => {
    reinitialiser('PYBBIL');
    const r = await auto.deduire('PYBBIL', depotPybbil({ datesCassees: true }));
    assert.strictEqual(auto.appliquer(r), false);
    assert.strictEqual(TABLES.PYBBIL.colonnes.date.bd, null, 'rien ne doit être écrit');
  });

  console.log('\nGarde-fou lecture seule de la connexion');
  const cx = require('../src/db/connexion');
  for (const sql of [
    'UPDATE PYBBIL SET PB007 = 0',
    'DELETE FROM TRANS',
    'DROP TABLE FACTMA',
    'SELECT * FROM PYBBIL; DELETE FROM PYBBIL',
    'EXEC sp_qui_sait',
  ]) {
    await test('refuse : ' + sql.slice(0, 40), async () => {
      let rejete = false;
      try { await cx.interroger(sql); } catch (e) { rejete = /lecture seule/.test(e.message); }
      assert.ok(rejete, 'la requête aurait dû être refusée par le garde-fou de lecture');
    });
  }

  await test('un SELECT légitime passe le garde-fou puis échoue faute de base', async () => {
    let msg = '';
    try { await cx.interroger('SELECT * FROM PYBBIL'); } catch (e) { msg = e.message; }
    assert.ok(!/lecture seule/.test(msg), 'ne doit pas être bloqué par le garde-fou : ' + msg);
  });

  console.log('\n' + reussis + ' réussis, ' + echecs + ' échecs');
  process.exit(echecs ? 1 : 0);
})();
