-- ═══════════════════════════════════════════════════════════════════════════
-- Règles d'intégrité comptable
--
-- Ces règles vivent dans la base, pas dans l'application. C'est délibéré :
-- les livres officiels doivent résister à un bug applicatif, à un script
-- d'appoint lancé à la main et à une connexion psql directe. Ce qui suit ne
-- peut être contourné par aucun de ces trois chemins.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- RÈGLE 1 — Une écriture validée doit être équilibrée
--
-- Vérifiée au COMMIT, pas à chaque INSERT : une écriture se construit ligne
-- par ligne et serait forcément déséquilibrée après la première ligne. Le
-- contrôle différé laisse construire, puis refuse de valider un déséquilibre.
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION gl.verifier_equilibre() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ecriture_id bigint;
  v_statut      text;
  v_debit       numeric(15,2);
  v_credit      numeric(15,2);
  v_lignes      integer;
BEGIN
  v_ecriture_id := COALESCE(NEW.ecriture_id, OLD.ecriture_id);

  SELECT statut INTO v_statut FROM gl.ecriture WHERE id = v_ecriture_id;
  IF v_statut IS NULL THEN
    RETURN NULL;  -- l'écriture a été supprimée dans la même transaction
  END IF;

  -- Un brouillon a le droit d'être déséquilibré : il est en cours de saisie.
  IF v_statut = 'brouillon' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(montant_debit), 0),
         COALESCE(sum(montant_credit), 0),
         count(*)
    INTO v_debit, v_credit, v_lignes
    FROM gl.ligne_ecriture WHERE ecriture_id = v_ecriture_id;

  IF v_lignes < 2 THEN
    RAISE EXCEPTION
      'Écriture % : une écriture validée compte au moins deux lignes (trouvé %)',
      v_ecriture_id, v_lignes
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'Écriture % déséquilibrée : débit % ≠ crédit % (écart %)',
      v_ecriture_id, v_debit, v_credit, (v_debit - v_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER equilibre_lignes
  AFTER INSERT OR UPDATE OR DELETE ON gl.ligne_ecriture
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl.verifier_equilibre();

-- Même contrôle quand c'est l'en-tête qui passe de brouillon à validée.
CREATE FUNCTION gl.verifier_equilibre_entete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_debit  numeric(15,2);
  v_credit numeric(15,2);
  v_lignes integer;
BEGIN
  IF NEW.statut = 'brouillon' THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(montant_debit), 0),
         COALESCE(sum(montant_credit), 0),
         count(*)
    INTO v_debit, v_credit, v_lignes
    FROM gl.ligne_ecriture WHERE ecriture_id = NEW.id;

  IF v_lignes < 2 THEN
    RAISE EXCEPTION
      'Écriture % : une écriture validée compte au moins deux lignes (trouvé %)',
      NEW.id, v_lignes
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'Écriture % déséquilibrée : débit % ≠ crédit % (écart %)',
      NEW.id, v_debit, v_credit, (v_debit - v_credit)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER equilibre_entete
  AFTER INSERT OR UPDATE ON gl.ecriture
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl.verifier_equilibre_entete();

-- ───────────────────────────────────────────────────────────────────────────
-- RÈGLE 2 — Une écriture validée est immuable
--
-- On ne corrige pas une écriture passée, on la contrepasse. C'est la règle
-- qui rend les livres vérifiables : l'historique ne se réécrit pas.
-- Seuls deux changements restent permis sur une écriture validée : la marquer
-- contrepassée et pointer vers son écriture d'annulation.
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION gl.proteger_ecriture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'brouillon' THEN
      RAISE EXCEPTION
        'Écriture % (%) ne peut pas être supprimée : seule une contrepassation annule une écriture validée',
        OLD.id, OLD.numero_piece
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.statut = 'brouillon' THEN
    RETURN NEW;  -- un brouillon se modifie librement
  END IF;

  IF OLD.statut = 'contrepassee' THEN
    RAISE EXCEPTION 'Écriture % déjà contrepassée : elle est définitivement figée', OLD.numero_piece
      USING ERRCODE = 'check_violation';
  END IF;

  -- statut = 'validee' : tout doit rester identique sauf la contrepassation
  IF NEW.exercice_id     IS DISTINCT FROM OLD.exercice_id
  OR NEW.periode_id      IS DISTINCT FROM OLD.periode_id
  OR NEW.journal_code    IS DISTINCT FROM OLD.journal_code
  OR NEW.numero_piece    IS DISTINCT FROM OLD.numero_piece
  OR NEW.date_ecriture   IS DISTINCT FROM OLD.date_ecriture
  OR NEW.libelle         IS DISTINCT FROM OLD.libelle
  OR NEW.source_type     IS DISTINCT FROM OLD.source_type
  OR NEW.source_id       IS DISTINCT FROM OLD.source_id
  OR NEW.cree_par        IS DISTINCT FROM OLD.cree_par
  OR NEW.cree_le         IS DISTINCT FROM OLD.cree_le
  THEN
    RAISE EXCEPTION
      'Écriture % est validée : son contenu est immuable. Passez par une contrepassation.',
      OLD.numero_piece
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.statut NOT IN ('validee', 'contrepassee') THEN
    RAISE EXCEPTION 'Écriture % : une écriture validée ne peut pas revenir à « % »',
      OLD.numero_piece, NEW.statut
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER proteger_ecriture
  BEFORE UPDATE OR DELETE ON gl.ecriture
  FOR EACH ROW EXECUTE FUNCTION gl.proteger_ecriture();

-- Les lignes d'une écriture validée sont figées elles aussi.
CREATE FUNCTION gl.proteger_lignes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_statut text;
  v_piece  text;
  v_id     bigint;
BEGIN
  v_id := COALESCE(NEW.ecriture_id, OLD.ecriture_id);
  SELECT statut, numero_piece INTO v_statut, v_piece FROM gl.ecriture WHERE id = v_id;

  IF v_statut IS NULL THEN
    RETURN COALESCE(NEW, OLD);  -- suppression en cascade de l'en-tête
  END IF;

  IF v_statut <> 'brouillon' THEN
    RAISE EXCEPTION
      'Écriture % est % : ses lignes sont immuables. Passez par une contrepassation.',
      v_piece, v_statut
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER proteger_lignes
  BEFORE INSERT OR UPDATE OR DELETE ON gl.ligne_ecriture
  FOR EACH ROW EXECUTE FUNCTION gl.proteger_lignes();

-- ───────────────────────────────────────────────────────────────────────────
-- RÈGLE 3 — Rien ne se passe dans une période ou un exercice fermé
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION gl.verifier_periode_ouverte() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_p_statut text; v_p_debut date; v_p_fin date; v_p_exercice integer;
  v_e_statut text;
BEGIN
  -- Sur une écriture déjà validée, la période et la date ne peuvent de toute
  -- façon pas changer : c'est gl.proteger_ecriture qui le garantit. On lui
  -- laisse la main pour que l'utilisateur reçoive le bon message — « écriture
  -- immuable » — plutôt qu'un reproche de date hors période qui l'enverrait
  -- corriger la mauvaise chose.
  IF TG_OP = 'UPDATE' AND OLD.statut <> 'brouillon' THEN
    RETURN NEW;
  END IF;

  SELECT statut, date_debut, date_fin, exercice_id
    INTO v_p_statut, v_p_debut, v_p_fin, v_p_exercice
    FROM gl.periode WHERE id = NEW.periode_id;

  SELECT statut INTO v_e_statut FROM gl.exercice WHERE id = NEW.exercice_id;

  IF v_p_exercice <> NEW.exercice_id THEN
    RAISE EXCEPTION 'Période % n''appartient pas à l''exercice %', NEW.periode_id, NEW.exercice_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_e_statut = 'ferme' THEN
    RAISE EXCEPTION 'Exercice % est fermé : aucune écriture ne peut y être passée', NEW.exercice_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_p_statut = 'fermee' THEN
    RAISE EXCEPTION 'Période % de l''exercice % est fermée', NEW.periode_id, NEW.exercice_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.date_ecriture < v_p_debut OR NEW.date_ecriture > v_p_fin THEN
    RAISE EXCEPTION
      'Date % hors de la période déclarée (% au %)', NEW.date_ecriture, v_p_debut, v_p_fin
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER periode_ouverte
  BEFORE INSERT OR UPDATE ON gl.ecriture
  FOR EACH ROW EXECUTE FUNCTION gl.verifier_periode_ouverte();

-- ───────────────────────────────────────────────────────────────────────────
-- RÈGLE 4 — Une écriture ne touche pas un compte de regroupement
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION gl.verifier_compte_imputable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_accepte boolean; v_actif boolean; v_nom text;
BEGIN
  SELECT accepte_ecriture, actif, nom INTO v_accepte, v_actif, v_nom
    FROM gl.compte WHERE numero = NEW.compte_numero;

  IF NOT v_accepte THEN
    RAISE EXCEPTION 'Compte % (%) est un compte de regroupement : il ne reçoit pas d''écriture',
      NEW.compte_numero, v_nom
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_actif THEN
    RAISE EXCEPTION 'Compte % (%) est désactivé', NEW.compte_numero, v_nom
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER compte_imputable
  BEFORE INSERT OR UPDATE ON gl.ligne_ecriture
  FOR EACH ROW EXECUTE FUNCTION gl.verifier_compte_imputable();

-- ───────────────────────────────────────────────────────────────────────────
-- RÈGLE 5 — Une période ne se ferme pas sur des brouillons
--
-- Un brouillon oublié dans une période fermée est une transaction perdue.
-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION gl.verifier_fermeture_periode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_brouillons integer;
BEGIN
  IF NEW.statut = 'fermee' AND OLD.statut = 'ouverte' THEN
    SELECT count(*) INTO v_brouillons
      FROM gl.ecriture WHERE periode_id = NEW.id AND statut = 'brouillon';

    IF v_brouillons > 0 THEN
      RAISE EXCEPTION
        'Période % : % écriture(s) au brouillon. Validez-les ou supprimez-les avant de fermer.',
        NEW.id, v_brouillons
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.date_fermeture := now();
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fermeture_periode
  BEFORE UPDATE ON gl.periode
  FOR EACH ROW EXECUTE FUNCTION gl.verifier_fermeture_periode();
