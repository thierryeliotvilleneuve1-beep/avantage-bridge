-- ═══════════════════════════════════════════════════════════════════════════
-- Amorce — journaux et comptes connus
--
-- ATTENTION : ce plan comptable n'est PAS complet. Il contient les cinq seuls
-- comptes que la rétro-ingénierie du pont a permis d'identifier dans Avantage,
-- plus les comptes de contrepartie minimaux pour faire tourner le socle.
-- Le plan comptable réel de CRC doit être extrait d'Avantage et importé avant
-- toute mise en service. Voir docs/AVANTAGE-MODELE-DONNEES.md, section 8.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO gl.journal (code, nom, type) VALUES
  ('VTE', 'Ventes — facturation client',        'vente'),
  ('ACH', 'Achats — factures fournisseurs',     'achat'),
  ('PAI', 'Paie — Employeur D',                 'paie'),
  ('BQ',  'Banque',                             'banque'),
  ('CAI', 'Caisse et petite caisse',            'caisse'),
  ('OD',  'Opérations diverses',                'divers'),
  ('CLO', 'Écritures de clôture',               'cloture');

-- Comptes de regroupement (n'acceptent pas d'écriture)
INSERT INTO gl.compte (numero, nom, type, sens_normal, accepte_ecriture) VALUES
  ('1000', 'ACTIF',                  'actif',            'D', false),
  ('2000', 'PASSIF',                 'passif',           'C', false),
  ('3000', 'CAPITAUX PROPRES',       'capitaux_propres', 'C', false),
  ('4000', 'REVENUS',                'revenus',          'C', false),
  ('5000', 'CHARGES',                'charges',          'D', false);

-- Comptes de taxe identifiés dans Avantage (ventilation PYBBIL)
INSERT INTO gl.compte (numero, nom, type, sous_type, sens_normal, parent_numero, code_taxe, reference_avantage) VALUES
  ('21300', 'TPS à payer',                 'passif', 'passif_courant', 'C', '2000', 'TPS',     'PYBBIL GL 21300'),
  ('21310', 'TVQ à payer',                 'passif', 'passif_courant', 'C', '2000', 'TVQ',     'PYBBIL GL 21310'),
  ('21340', 'TPS à recevoir (CTI)',        'actif',  'actif_courant',  'D', '1000', 'TPS_CTI', 'PYBBIL GL 21340'),
  ('21370', 'TVQ à recevoir (RTI)',        'actif',  'actif_courant',  'D', '1000', 'TVQ_RTI', 'PYBBIL GL 21370');

-- Comptes de contrepartie minimaux
INSERT INTO gl.compte (numero, nom, type, sous_type, sens_normal, parent_numero, reference_avantage) VALUES
  ('11000', 'Encaisse — compte d''opération', 'actif',   'actif_courant',        'D', '1000', NULL),
  ('12000', 'Comptes clients',                'actif',   'actif_courant',        'D', '1000', NULL),
  ('12500', 'Retenues contractuelles à recevoir', 'actif', 'actif_courant',      'D', '1000', NULL),
  ('21000', 'Comptes fournisseurs',           'passif',  'passif_courant',       'C', '2000', NULL),
  ('21500', 'Retenues contractuelles à payer','passif',  'passif_courant',       'C', '2000', NULL),
  ('41000', 'Revenus de contrats',            'revenus', 'revenus_exploitation', 'C', '4000', NULL),
  ('33200', 'Coût des travaux — projets',     'charges', 'charges_exploitation', 'D', '5000', 'PYBBIL GL 33200'),
  ('51000', 'Main-d''œuvre — projets',        'charges', 'charges_exploitation', 'D', '5000', 'Activité 06101'),
  ('59000', 'Frais généraux',                 'charges', 'charges_exploitation', 'D', '5000', NULL);
