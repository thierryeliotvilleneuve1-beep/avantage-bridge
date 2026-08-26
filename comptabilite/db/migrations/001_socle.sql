-- ═══════════════════════════════════════════════════════════════════════════
-- Socle du grand livre — Construction Richard Champagne
--
-- Ce schéma porte les livres officiels de CRC. Les règles comptables qui ne
-- peuvent JAMAIS être violées sont posées ici, dans la base, et non dans le
-- code applicatif : une écriture déséquilibrée, une écriture modifiée après
-- validation ou une écriture dans une période fermée sont rejetées par
-- PostgreSQL lui-même. Aucun bug applicatif, aucun script d'appoint et aucun
-- accès direct à la base ne peut contourner ça.
--
-- Montants : numeric(15,2). Jamais de flottant dans un livre comptable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS gl;

-- ───────────────────────────────────────────────────────────────────────────
-- Exercices financiers
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.exercice (
  id            integer PRIMARY KEY,              -- l'année, ex. 2026
  date_debut    date        NOT NULL,
  date_fin      date        NOT NULL,
  statut        text        NOT NULL DEFAULT 'ouvert'
                CHECK (statut IN ('ouvert', 'ferme')),
  date_fermeture timestamptz,
  ferme_par     text,
  CHECK (date_fin > date_debut)
);

COMMENT ON TABLE gl.exercice IS
  'Exercice financier. Une fois fermé, plus aucune écriture ne peut y être passée.';

-- ───────────────────────────────────────────────────────────────────────────
-- Périodes comptables
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.periode (
  id            serial PRIMARY KEY,
  exercice_id   integer     NOT NULL REFERENCES gl.exercice(id),
  numero        smallint    NOT NULL CHECK (numero BETWEEN 1 AND 13),
  date_debut    date        NOT NULL,
  date_fin      date        NOT NULL,
  statut        text        NOT NULL DEFAULT 'ouverte'
                CHECK (statut IN ('ouverte', 'fermee')),
  date_fermeture timestamptz,
  ferme_par     text,
  UNIQUE (exercice_id, numero),
  CHECK (date_fin >= date_debut)
);

COMMENT ON COLUMN gl.periode.numero IS
  '1 à 12 pour les mois, 13 réservée aux écritures de fin d''exercice.';

-- ───────────────────────────────────────────────────────────────────────────
-- Journaux
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.journal (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z]{2,4}$'),
  nom           text        NOT NULL,
  type          text        NOT NULL
                CHECK (type IN ('vente','achat','paie','banque','caisse','divers','cloture')),
  actif         boolean     NOT NULL DEFAULT true
);

-- ───────────────────────────────────────────────────────────────────────────
-- Plan comptable
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.compte (
  numero            text PRIMARY KEY CHECK (numero ~ '^[0-9]{4,8}$'),
  nom               text     NOT NULL,
  type              text     NOT NULL
                    CHECK (type IN ('actif','passif','capitaux_propres','revenus','charges')),
  sous_type         text,
  -- Sens normal du solde. Un compte d'actif ou de charge est normalement
  -- débiteur ; un compte de passif, de capitaux propres ou de revenu est
  -- normalement créditeur. Sert aux rapports, pas à bloquer les écritures :
  -- un compte peut légitimement être en sens inverse (découvert bancaire).
  sens_normal       char(1)  NOT NULL CHECK (sens_normal IN ('D','C')),
  -- Un compte de regroupement ne reçoit pas d'écriture, il totalise ses enfants.
  accepte_ecriture  boolean  NOT NULL DEFAULT true,
  parent_numero     text     REFERENCES gl.compte(numero),
  -- Marque les comptes de taxe, pour la production des déclarations TPS/TVQ.
  code_taxe         text     CHECK (code_taxe IN ('TPS','TVQ','TPS_CTI','TVQ_RTI')),
  actif             boolean  NOT NULL DEFAULT true,
  reference_avantage text
);

COMMENT ON COLUMN gl.compte.code_taxe IS
  'Renseigné sur les comptes de taxe. CTI/RTI = taxes payées récupérables ; TPS/TVQ = taxes perçues à remettre.';

-- ───────────────────────────────────────────────────────────────────────────
-- Écritures (en-tête)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.ecriture (
  id                bigserial PRIMARY KEY,
  exercice_id       integer     NOT NULL REFERENCES gl.exercice(id),
  periode_id        integer     NOT NULL REFERENCES gl.periode(id),
  journal_code      text        NOT NULL REFERENCES gl.journal(code),
  numero_piece      text        NOT NULL,
  date_ecriture     date        NOT NULL,
  libelle           text        NOT NULL CHECK (length(trim(libelle)) > 0),

  statut            text        NOT NULL DEFAULT 'brouillon'
                    CHECK (statut IN ('brouillon','validee','contrepassee')),

  -- Provenance : d'où vient cette écriture. Indispensable à la piste d'audit
  -- et à l'idempotence des automatismes (une facture ne se passe qu'une fois).
  source_type       text        NOT NULL DEFAULT 'manuelle',
  source_id         text,

  -- Contrepassation : une écriture validée ne se modifie pas, elle s'annule
  -- par une écriture inverse. Les deux se pointent mutuellement.
  contrepasse_id    bigint      REFERENCES gl.ecriture(id),
  contrepassee_par_id bigint    REFERENCES gl.ecriture(id),

  cree_par          text        NOT NULL,
  cree_le           timestamptz NOT NULL DEFAULT now(),
  valide_par        text,
  valide_le         timestamptz,

  UNIQUE (exercice_id, journal_code, numero_piece)
);

-- Une écriture issue d'un automatisme ne doit exister qu'une seule fois.
-- C'est ce qui rend les synchros rejouables sans créer de doublons.
CREATE UNIQUE INDEX ecriture_source_unique
  ON gl.ecriture (source_type, source_id)
  WHERE source_id IS NOT NULL AND statut <> 'contrepassee';

CREATE INDEX ecriture_periode_idx ON gl.ecriture (periode_id, statut);
CREATE INDEX ecriture_date_idx    ON gl.ecriture (date_ecriture);

-- ───────────────────────────────────────────────────────────────────────────
-- Lignes d'écriture
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.ligne_ecriture (
  id                bigserial PRIMARY KEY,
  ecriture_id       bigint       NOT NULL REFERENCES gl.ecriture(id) ON DELETE CASCADE,
  rang              smallint     NOT NULL,
  compte_numero     text         NOT NULL REFERENCES gl.compte(numero),
  libelle           text,

  montant_debit     numeric(15,2) NOT NULL DEFAULT 0 CHECK (montant_debit  >= 0),
  montant_credit    numeric(15,2) NOT NULL DEFAULT 0 CHECK (montant_credit >= 0),

  -- Une ligne est soit au débit, soit au crédit, jamais les deux ni aucun.
  CONSTRAINT ligne_sens_unique CHECK (
    (montant_debit > 0 AND montant_credit = 0) OR
    (montant_credit > 0 AND montant_debit = 0)
  ),

  -- Dimensions analytiques. Le projet et l'activité restent des codes texte :
  -- ils appartiennent à Manœuvre, le grand livre ne fait que les porter.
  code_projet       text,
  code_activite     text,
  code_taxe         text,

  -- Tiers concerné (fournisseur ou client), pour les auxiliaires et le T5018.
  tiers_type        text CHECK (tiers_type IN ('fournisseur','client','employe')),
  tiers_id          text,

  UNIQUE (ecriture_id, rang)
);

CREATE INDEX ligne_compte_idx  ON gl.ligne_ecriture (compte_numero);
CREATE INDEX ligne_projet_idx  ON gl.ligne_ecriture (code_projet, code_activite);
CREATE INDEX ligne_tiers_idx   ON gl.ligne_ecriture (tiers_type, tiers_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Numérotation séquentielle sans trou, par exercice et par journal
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE gl.compteur_piece (
  exercice_id   integer NOT NULL REFERENCES gl.exercice(id),
  journal_code  text    NOT NULL REFERENCES gl.journal(code),
  dernier       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (exercice_id, journal_code)
);

CREATE FUNCTION gl.prochain_numero_piece(p_exercice integer, p_journal text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO gl.compteur_piece (exercice_id, journal_code, dernier)
       VALUES (p_exercice, p_journal, 0)
  ON CONFLICT (exercice_id, journal_code) DO NOTHING;

  -- Le UPDATE ... RETURNING sérialise les demandes concurrentes : deux
  -- écritures simultanées ne peuvent pas obtenir le même numéro.
  UPDATE gl.compteur_piece
     SET dernier = dernier + 1
   WHERE exercice_id = p_exercice AND journal_code = p_journal
  RETURNING dernier INTO v_n;

  RETURN p_journal || '-' || p_exercice || '-' || lpad(v_n::text, 6, '0');
END $$;
