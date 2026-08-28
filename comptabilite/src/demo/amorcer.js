'use strict';

const gl = require('../grandlivre/ecritures');

/**
 * Jeu de démonstration : données plausibles de CRC sur le projet témoin
 * P23020 — Caserne Wemotaci, avec ses vrais codes de division.
 *
 * Rien ici n'est du vrai argent. Le but est de pouvoir ouvrir l'écran et
 * cliquer, avant même qu'une base soit hébergée.
 */

const U = 'demo@c-rc.ca';

const FOURNISSEURS = [
  { id: 'PROARM', nom: 'Pro Armature',            activite: '03530', ht: 37819.50 },
  { id: 'COFFRA', nom: 'Coffrages Mauricie',      activite: '03000', ht: 18240.00 },
  { id: 'ELECST', nom: 'Électricité Saint-Tite',  activite: '16130', ht: 24500.00 },
  { id: 'VENTMA', nom: 'Ventilation Mékinac',     activite: '15410', ht:  9875.25 },
  { id: 'TOITUR', nom: 'Toitures Batiscan',       activite: '07330', ht: 41200.00 },
];

const TPS = 0.05, TVQ = 0.09975;
const cents = (n) => Math.round(n * 100) / 100;

async function amorcer(db) {
  // Exercice courant
  const dejaOuvert = await db.query(`SELECT id FROM gl.exercice WHERE id = 2026`);
  if (!dejaOuvert.rows.length) {
    await db.transaction((tx) => gl.ouvrirExercice(tx, 2026));
  }

  // Compte bancaire
  await db.query(
    `INSERT INTO banque.compte_bancaire (id, nom, institution, masque, compte_gl, plaid_derniere_sync)
     VALUES (1, 'Compte d''opération', 'Desjardins', '4417', '11000', now())
     ON CONFLICT (id) DO NOTHING`
  );
  await db.query(`SELECT setval(pg_get_serial_sequence('banque.compte_bancaire','id'), 1, true)`);

  // Règles de catégorisation
  await db.query(
    `INSERT INTO banque.regle
       (nom, priorite, motif_description, compte_gl, code_projet, code_activite, automatique, cree_par)
     VALUES
       ('Hydro-Québec — préautorisé',  10, 'HYDRO',              '59000', NULL, NULL, true,  $1),
       ('Frais bancaires mensuels',    15, 'FRAIS (MENSUEL|SERVICE)', '59000', NULL, NULL, true, $1),
       ('Carburant — flotte',          40, '(ESSENCE|SHELL|ULTRAMAR|PETRO)', '59000', NULL, NULL, false, $1),
       ('Paiement fournisseur',        90, '(PAIEMENT|VIREMENT|CHEQUE)', '21000', NULL, NULL, false, $1)`,
    [U]
  );

  // ── Factures fournisseurs déjà comptabilisées : elles ouvrent les dettes
  //    que les paiements bancaires viendront éteindre.
  let jour = 4;
  for (const f of FOURNISSEURS) {
    const tps = cents(f.ht * TPS);
    const tvq = cents(f.ht * TVQ);
    const ttc = cents(f.ht + tps + tvq);
    await db.transaction((tx) => gl.passer(tx, {
      exercice: 2026, journal: 'ACH',
      date: `2026-03-${String(jour).padStart(2, '0')}`,
      libelle: `${f.nom} — P23020`,
      utilisateur: U,
      sourceType: 'facture_fournisseur', sourceId: `demo:${f.id}`,
      lignes: [
        { compte: '33200', debit: f.ht, projet: '23020', activite: f.activite, libelle: f.nom },
        { compte: '21340', debit: tps, taxe: 'TPS_CTI' },
        { compte: '21370', debit: tvq, taxe: 'TVQ_RTI' },
        { compte: '21000', credit: ttc, tiersType: 'fournisseur', tiersId: f.id },
      ],
    }));
    jour += 2;
  }

  // Facturation progressive au client
  await db.transaction((tx) => gl.passer(tx, {
    exercice: 2026, journal: 'VTE', date: '2026-03-25',
    libelle: 'Facture progressive n° 3 — P23020 Caserne Wemotaci',
    utilisateur: U, sourceType: 'facture_client', sourceId: 'demo:FC-003',
    lignes: [
      { compte: '12000', debit: 172500.00, tiersType: 'client', tiersId: 'ATIKAMEKW' },
      { compte: '12500', debit: 15000.00, libelle: 'Retenue contractuelle 10 %' },
      { compte: '41000', credit: 150000.00, projet: '23020' },
      { compte: '21300', credit: 7500.00, taxe: 'TPS' },
      { compte: '21310', credit: 14962.50, taxe: 'TVQ' },
      { compte: '12500', credit: 15037.50, libelle: 'Ajustement retenue' },
    ],
  }));

  // ── Transactions bancaires à traiter ──────────────────────────────────
  const mouvements = [
    ['2026-03-06', 'HYDRO QUEBEC PREAUT 4417',            'Hydro-Québec',      -812.44],
    ['2026-03-09', 'PAIEMENT PRO ARMATURE',               'Pro Armature',    -43507.61],
    ['2026-03-11', 'ESSENCE ULTRAMAR ST-TITE',            'Ultramar',          -284.15],
    ['2026-03-13', 'DEPOT CONSEIL ATIKAMEKW WEMOTACI',    null,             172500.00],
    ['2026-03-16', 'PAIEMENT COFFRAGES MAURICIE',         'Coffrages Mauricie',-20977.10],
    ['2026-03-18', 'FRAIS MENSUEL SERVICE ENTREPRISE',    'Desjardins',         -49.95],
    ['2026-03-20', 'ACHAT QUINCAILLERIE BMR SHAWINIGAN',  'BMR',              -1247.83],
    ['2026-03-23', 'ESSENCE PETRO-CANADA HEROUXVILLE',    'Petro-Canada',      -196.40],
    ['2026-03-24', 'VIREMENT ELECTRICITE SAINT-TITE',     'Électricité Saint-Tite', -28169.38],
    ['2026-03-26', 'DEBIT PREAUTORISE ASSURANCE FLOTTE',  'Intact',           -2340.00],
  ];

  for (const [date, description, marchand, montant] of mouvements) {
    await db.query(
      `INSERT INTO banque.transaction
         (compte_id, plaid_transaction_id, date_transaction, description, marchand, montant)
       VALUES (1, $1, $2, $3, $4, $5)`,
      [`demo-${date}-${Math.abs(montant)}`, date, description, marchand, montant]
    );
  }

  return { fournisseurs: FOURNISSEURS.length, mouvements: mouvements.length };
}

module.exports = { amorcer };
