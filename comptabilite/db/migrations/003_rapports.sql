-- ═══════════════════════════════════════════════════════════════════════════
-- Vues de rapport
--
-- Règle commune : un brouillon n'existe pas dans les livres. Une écriture
-- contrepassée, elle, y reste — c'est son annulation qui vient l'équilibrer.
-- Les deux apparaissent donc, et leur somme est nulle. C'est ce qui distingue
-- une correction traçable d'une réécriture de l'histoire.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE VIEW gl.mouvement AS
SELECT
  l.id                AS ligne_id,
  e.id                AS ecriture_id,
  e.exercice_id,
  e.periode_id,
  e.journal_code,
  e.numero_piece,
  e.date_ecriture,
  e.libelle           AS libelle_ecriture,
  e.statut,
  l.rang,
  l.compte_numero,
  c.nom               AS compte_nom,
  c.type              AS compte_type,
  c.sens_normal,
  l.libelle           AS libelle_ligne,
  l.montant_debit,
  l.montant_credit,
  l.montant_debit - l.montant_credit AS mouvement_net,
  l.code_projet,
  l.code_activite,
  l.code_taxe,
  l.tiers_type,
  l.tiers_id
FROM gl.ligne_ecriture l
JOIN gl.ecriture       e ON e.id = l.ecriture_id
JOIN gl.compte         c ON c.numero = l.compte_numero
WHERE e.statut <> 'brouillon';

COMMENT ON VIEW gl.mouvement IS
  'Toutes les lignes qui comptent dans les livres. Base de tous les rapports.';

-- ───────────────────────────────────────────────────────────────────────────
-- Balance de vérification
--
-- Le contrôle santé du grand livre : le total des débits doit égaler le total
-- des crédits, sur toute la base, en tout temps.
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW gl.balance_verification AS
SELECT
  m.exercice_id,
  m.compte_numero,
  m.compte_nom,
  m.compte_type,
  m.sens_normal,
  sum(m.montant_debit)  AS total_debit,
  sum(m.montant_credit) AS total_credit,
  sum(m.mouvement_net)  AS solde_debiteur,
  CASE WHEN m.sens_normal = 'D' THEN sum(m.mouvement_net)
       ELSE -sum(m.mouvement_net) END AS solde_sens_normal
FROM gl.mouvement m
GROUP BY m.exercice_id, m.compte_numero, m.compte_nom, m.compte_type, m.sens_normal;

-- ───────────────────────────────────────────────────────────────────────────
-- Contrôle d'équilibre global — doit toujours renvoyer un écart de 0
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW gl.controle_equilibre AS
SELECT
  exercice_id,
  sum(montant_debit)                     AS total_debit,
  sum(montant_credit)                    AS total_credit,
  sum(montant_debit) - sum(montant_credit) AS ecart,
  sum(montant_debit) = sum(montant_credit) AS equilibre
FROM gl.mouvement
GROUP BY exercice_id;

-- ───────────────────────────────────────────────────────────────────────────
-- Coût par projet et par activité — le pont vers le contrôle budgétaire
--
-- Remplace ce que le pont Avantage reconstituait péniblement depuis TRANS,
-- PYBBIL et COMITE : ici l'imputation analytique est portée par la ligne
-- d'écriture elle-même, donc exacte par construction.
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW gl.cout_projet AS
SELECT
  m.exercice_id,
  m.code_projet,
  m.code_activite,
  m.compte_type,
  sum(m.mouvement_net) AS montant
FROM gl.mouvement m
WHERE m.code_projet IS NOT NULL
GROUP BY m.exercice_id, m.code_projet, m.code_activite, m.compte_type;

-- ───────────────────────────────────────────────────────────────────────────
-- Assiette des taxes — socle des déclarations TPS/TVQ
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW gl.assiette_taxes AS
SELECT
  m.exercice_id,
  m.periode_id,
  m.code_taxe,
  sum(m.montant_credit) AS taxe_percue,
  sum(m.montant_debit)  AS taxe_payee
FROM gl.mouvement m
WHERE m.code_taxe IS NOT NULL
GROUP BY m.exercice_id, m.periode_id, m.code_taxe;
