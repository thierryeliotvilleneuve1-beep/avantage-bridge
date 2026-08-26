-- ═══════════════════════════════════════════════════════════════════════════
-- Liaison bancaire et rapprochement
--
-- C'est la principale lacune d'Avantage : aucun flux bancaire, tout se saisit
-- à la main. Ici, les transactions arrivent de Plaid, atterrissent en zone de
-- transit, se font catégoriser par des règles, puis deviennent des écritures.
--
-- Une transaction bancaire N'EST PAS une écriture. Elle vit dans son propre
-- schéma jusqu'à ce qu'elle soit rapprochée. Le grand livre ne reçoit que ce
-- qui a été qualifié — jamais un flux brut.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS banque;

-- ───────────────────────────────────────────────────────────────────────────
-- Comptes bancaires reliés
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE banque.compte_bancaire (
  id                serial PRIMARY KEY,
  nom               text        NOT NULL,
  institution       text,
  masque            text,                       -- 4 derniers chiffres
  devise            char(3)     NOT NULL DEFAULT 'CAD',

  -- Compte du grand livre que ce compte bancaire alimente.
  compte_gl         text        NOT NULL REFERENCES gl.compte(numero),

  -- Plaid. Le jeton d'accès est un secret de longue durée : il ne doit jamais
  -- transiter vers le navigateur ni apparaître dans un journal applicatif.
  plaid_item_id     text UNIQUE,
  plaid_account_id  text UNIQUE,
  plaid_curseur     text,                       -- curseur /transactions/sync
  plaid_derniere_sync timestamptz,
  plaid_erreur      text,

  actif             boolean     NOT NULL DEFAULT true
);

COMMENT ON COLUMN banque.compte_bancaire.plaid_curseur IS
  'Curseur Plaid /transactions/sync. Rend la synchro incrémentale et rejouable : Plaid ne renvoie que ce qui a changé depuis.';

-- ───────────────────────────────────────────────────────────────────────────
-- Transactions bancaires — zone de transit
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE banque.transaction (
  id                bigserial PRIMARY KEY,
  compte_id         integer     NOT NULL REFERENCES banque.compte_bancaire(id),

  plaid_transaction_id text     UNIQUE,
  date_transaction  date        NOT NULL,
  date_autorisation date,
  description       text        NOT NULL,
  marchand          text,

  -- Convention : positif = entrée d'argent, négatif = sortie.
  -- Plaid utilise l'inverse ; la conversion se fait à l'ingestion, une fois.
  montant           numeric(15,2) NOT NULL,
  devise            char(3)     NOT NULL DEFAULT 'CAD',

  categorie_plaid   text,
  en_attente        boolean     NOT NULL DEFAULT false,

  statut            text        NOT NULL DEFAULT 'a_traiter'
                    CHECK (statut IN ('a_traiter','suggeree','rapprochee','ignoree')),

  -- Écriture générée lors du rapprochement.
  ecriture_id       bigint      REFERENCES gl.ecriture(id),

  -- Suggestion automatique en attente de confirmation humaine.
  suggestion_compte text        REFERENCES gl.compte(numero),
  suggestion_projet text,
  suggestion_activite text,
  suggestion_regle_id integer,
  suggestion_score  numeric(4,3),

  recu_le           timestamptz NOT NULL DEFAULT now(),
  rapproche_par     text,
  rapproche_le      timestamptz,

  CHECK (statut <> 'rapprochee' OR ecriture_id IS NOT NULL)
);

CREATE INDEX transaction_compte_idx ON banque.transaction (compte_id, date_transaction DESC);
CREATE INDEX transaction_statut_idx ON banque.transaction (statut) WHERE statut <> 'rapprochee';

COMMENT ON CONSTRAINT transaction_statut_check ON banque.transaction IS
  'Une transaction déclarée rapprochée doit pointer vers son écriture. Pas de rapprochement fantôme.';

-- ───────────────────────────────────────────────────────────────────────────
-- Règles de catégorisation automatique
--
-- C'est le cœur de l'automatisation : un loyer, une facture d'essence ou un
-- virement récurrent ne devrait jamais demander de saisie. Les règles les
-- reconnaissent et proposent l'imputation.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE banque.regle (
  id                serial PRIMARY KEY,
  nom               text        NOT NULL,
  -- Plus la priorité est basse, plus la règle est évaluée tôt.
  priorite          smallint    NOT NULL DEFAULT 100,

  -- Critères. Tous ceux qui sont renseignés doivent correspondre.
  motif_description text,                       -- expression régulière, insensible à la casse
  montant_min       numeric(15,2),
  montant_max       numeric(15,2),
  compte_id         integer     REFERENCES banque.compte_bancaire(id),

  -- Imputation proposée.
  compte_gl         text        NOT NULL REFERENCES gl.compte(numero),
  code_projet       text,
  code_activite     text,
  tiers_type        text CHECK (tiers_type IN ('fournisseur','client','employe')),
  tiers_id          text,

  -- Une règle sûre passe l'écriture toute seule ; sinon elle propose et
  -- attend une confirmation. On ne laisse pas une machine écrire aux livres
  -- officiels sans que quelqu'un ait décidé qu'elle en a le droit.
  automatique       boolean     NOT NULL DEFAULT false,

  actif             boolean     NOT NULL DEFAULT true,
  cree_par          text,
  cree_le           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX regle_ordre_idx ON banque.regle (priorite, id) WHERE actif;

ALTER TABLE banque.transaction
  ADD CONSTRAINT transaction_regle_fk
  FOREIGN KEY (suggestion_regle_id) REFERENCES banque.regle(id);

-- ───────────────────────────────────────────────────────────────────────────
-- Vue de travail : ce qui reste à traiter
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW banque.a_traiter AS
SELECT
  t.id, t.compte_id, cb.nom AS compte_nom,
  t.date_transaction, t.description, t.marchand, t.montant,
  t.statut, t.en_attente,
  t.suggestion_compte, c.nom AS suggestion_compte_nom,
  t.suggestion_projet, t.suggestion_activite, t.suggestion_score,
  r.nom AS regle_nom
FROM banque.transaction t
JOIN banque.compte_bancaire cb ON cb.id = t.compte_id
LEFT JOIN gl.compte     c ON c.numero = t.suggestion_compte
LEFT JOIN banque.regle  r ON r.id = t.suggestion_regle_id
WHERE t.statut IN ('a_traiter', 'suggeree')
ORDER BY t.date_transaction DESC, t.id DESC;

-- ───────────────────────────────────────────────────────────────────────────
-- Jetons d'accès Plaid — table isolée
--
-- Un access_token Plaid donne accès en lecture aux comptes bancaires de CRC et
-- n'expire pas. Il vit dans sa propre table pour qu'on puisse lui appliquer des
-- droits plus stricts qu'au reste du schéma : le rôle applicatif qui sert les
-- écrans n'a aucune raison de pouvoir le lire. Il ne doit jamais être renvoyé
-- par une API, ni apparaître dans un journal.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE banque.plaid_item (
  item_id           text PRIMARY KEY,
  access_token      text        NOT NULL,
  institution_id    text,
  institution_nom   text,
  -- Plaid signale ici quand la banque exige une nouvelle authentification.
  besoin_reauth     boolean     NOT NULL DEFAULT false,
  derniere_erreur   text,
  cree_le           timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON banque.plaid_item FROM PUBLIC;

COMMENT ON TABLE banque.plaid_item IS
  'Secrets Plaid. Accès à restreindre au seul rôle de synchronisation bancaire.';
