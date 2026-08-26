# Remplacer Avantage par Manœuvre — analyse d'écart et plan

> ⚠️ **CE DOCUMENT EST SUPERSÉDÉ.**
> Il a été écrit avant la décision. Sa recommandation — ne faire que la
> comptabilité de projet et remettre le livre officiel à plus tard — a été
> écartée le 26 août 2026 : CRC remplace Avantage au complet, livre officiel
> inclus. Voir **`ARCHITECTURE-COMPTABILITE.md`**.
> Ce qui reste valable ici : l'analyse d'écart de la section 1 et l'inventaire
> des préalables de la section 5.

> Suite du document `AVANTAGE-MODELE-DONNEES.md`.
> Cible : **Manœuvre** (Base44, app `68927e133cde9f63295dd616`), **136 entités** existantes.
> Objectif énoncé : cesser de chercher un autre système comptable et reconstruire
> Avantage dans Manœuvre.

---

## 1. Verdict en une page

Manœuvre couvre **déjà l'essentiel de la comptabilité de projet** d'Avantage. Ce qui manque
n'est pas de la comptabilité de chantier — c'est de la **comptabilité générale réglementée**.

| Bloc fonctionnel Avantage | Couverture Manœuvre | Effort restant |
|---|---|---|
| Comptabilité de projet (budget × activité, engagé, MO, EAC) | ✅ **`ControleBudgetaire`, `BudgetProjet`** | Faible — déjà alimenté par le bridge |
| Bons de commande | ✅ **`BonDeCommande`** (30 champs, plus riche qu'Avantage) | Nul |
| Comptes-clients (AR) | ✅ **`FactureClient`, `Paiement`, `DemandesPaiement`** — TPS/TVQ et retenue de garantie déjà modélisés | Faible |
| Comptes-fournisseurs (AP) | ✅ **`FactureFournisseur`, `PaiementFournisseur`, `QuittanceSousTraitant`** — retenue à la source déjà modélisée | Faible |
| Heures / coût MO | ✅ **`SaisieHeure`, `FeuilleDeTempo`, `ImportRapportPaie`** | Faible |
| Trésorerie prévisionnelle | ✅ **`DecaissementPrevu`, `EncaissementPrevu`, `ParametresCashflow`** — **absent d'Avantage** | Nul |
| Plan comptable + écritures | ⚠️ **Coquilles** : `CompteComptable`, `EcritureComptable`, `LigneEcriture` existent, vides de logique | **Moyen** |
| Rapprochement bancaire | ⚠️ **`RapprochementBancaire`** = 7 champs, aucune mécanique | **Moyen** |
| Journaux, fermeture de période / d'exercice | ❌ Absent | **Élevé** |
| États financiers (bilan, résultats) | ❌ Absent | **Élevé** |
| Paie complète (DAS, T4/RL-1, CCQ) | ❌ Absent | **Très élevé** |
| Déclarations TPS/TVQ, **T5018** | ❌ Absent | **Élevé — obligation légale** |
| Immobilisations / amortissement | ❌ Absent (`Equipement`, `DepenseEquipement` existent mais sans amortissement) | Moyen |

---

## 2. Le point à trancher avant de coder

Il faut séparer deux décisions que « remplacer Avantage » confond :

**(A) Faire de Manœuvre le système de contrôle des coûts de projet.**
Réaliste, déjà à 70 %, valeur immédiate, aucun risque réglementaire. Le bridge devient
inutile le jour où les BC, factures et heures sont saisis nativement dans Manœuvre.

**(B) Faire de Manœuvre le livre comptable officiel de CRC.**
C'est la partie coûteuse : partie double vérifiable, pistes d'audit, fermeture d'exercice,
production des états financiers, déclarations gouvernementales, paie CCQ. Ces livres sont
examinés par un comptable externe et par Revenu Québec ; une erreur d'implémentation n'est
pas un bug, c'est un risque fiscal. C'est aussi ce qui explique pourquoi remplacer Avantage
est cher — pas la partie chantier.

**Recommandation : faire (A) au complet et le mettre en production, puis décider de (B)
avec des chiffres réels en main.** Le plan ci-dessous est séquencé dans cet ordre, mais
il couvre les deux : (B) reste livrable, simplement après (A).

---

## 3. Phase A — Autonomiser la comptabilité de projet

**But : supprimer la dépendance à l'export manuel d'Avantage pour tout ce qui touche
le contrôle budgétaire.**

### A1 — Corriger les défauts hérités d'Avantage (ne pas les recopier)

| Défaut Avantage | Correction dans Manœuvre |
|---|---|
| BC multi-activités imputé à sa 1ʳᵉ activité seulement | `BonDeCommande.lignes_commande` (déjà un `array`) → une imputation `controle_budgetaire_id` **par ligne** |
| Facture fournisseur sans BC = non imputable | `FactureFournisseur` → ajouter une ventilation multi-divisions obligatoire |
| N° de commande 7 vs 9 chiffres | Identifiant interne unique ; `reference_avantage` conservé en champ mort d'historique |
| `CONACT.CAVENIR` non alimenté | Reconstruire l'EAC = engagé + MO + reste à engager, calculé, pas saisi |
| Codes d'activité en `.00` | Normalisation à l'import, un seul format canonique |

### A2 — Créer le plan d'activités comme entité de premier rang

Aujourd'hui `ACTIVE` (1 089 lignes) n'est qu'une table de libellés lue à la volée par
`parseActive.js`. Il faut une entité **`DivisionActivite`** : `code`, `nom_fr`, `nom_en`,
`division_masterformat`, `type` (`travaux` | `main_oeuvre` | `gestion`), `actif`.
C'est le référentiel qui rend Manœuvre indépendant d'Avantage.

### A3 — Saisie native, bridge en lecture seule

Ordre de bascule, un flux à la fois, avec double saisie pendant un mois :
1. **Bons de commande** — déjà entièrement dans Manœuvre, le plus simple à basculer
2. **Heures / MO** — `SaisieHeure` + `ImportRapportPaie` existent déjà
3. **Factures fournisseurs** — `FactureFournisseur` + approbation (`FactureApprobation`, `ConfigApprobationFacture`)
4. **Factures clients / demandes de paiement** — `FactureClient`, `DemandesPaiement`
5. Le bridge passe en **réconciliation** : il ne pousse plus, il compare et signale les écarts
   (`verify-p23020.js` est déjà exactement cet outil — c'est le point de départ)

### A4 — Migration historique

Importer les 1 291 projets de `CONTRA` et leurs budgets `CONPRE` dans `Projet` +
`ControleBudgetaire`, en figeant les projets clos. Le bridge sait déjà le faire projet par
projet ; il manque la boucle multi-projets (déjà listée comme « prochaine évolution » du skill).

---

## 4. Phase B — La comptabilité générale

À ne lancer qu'avec le comptable externe de CRC dans la boucle, dès la conception.

### B1 — Grand livre en partie double

Les entités existent (`CompteComptable`, `EcritureComptable`, `LigneEcriture`) mais sans aucune
mécanique. Il faut :
- Validation **débit = crédit** à l'écriture, refus sinon
- **Immutabilité** des écritures validées (statut `valide` → plus de modification, seulement contrepassation)
- Numérotation de pièce séquentielle sans trou
- Journaux : ventes, achats, paie, banque, caisse, OD (le champ `type_operation` les prévoit déjà)
- Génération **automatique** des écritures depuis `FactureClient`, `FactureFournisseur`,
  `Paiement`, `PaiementFournisseur`, `SaisieHeure` — c'est là qu'est le vrai travail

### B2 — Plan comptable réel

Seuls 5 comptes GL sont connus du bridge (21300, 21310, 21340, 21370, 33200). Il faut extraire
le plan comptable complet d'Avantage et le charger dans `CompteComptable`.

### B3 — Périodes et fermeture

Entité `PeriodeComptable` (absente) : exercice, période, statut ouvert/fermé, date de fermeture.
Aucune écriture dans une période fermée. Report des soldes à l'ouverture d'exercice.

### B4 — États financiers

Balance de vérification, bilan, état des résultats, résultats **par projet**. Techniquement
simple une fois B1 et B3 en place — c'est une agrégation de `LigneEcriture`.

### B5 — Obligations réglementaires

| Obligation | Statut |
|---|---|
| TPS / TVQ | Champs présents sur `FactureClient` ; agrégation et déclaration à bâtir |
| **T5018** (paiements aux sous-traitants) | ❌ à bâtir — `QuittanceSousTraitant` et `PaiementFournisseur` portent déjà les données sources |
| DAS | ❌ dépend de la paie |
| CCQ | ❌ dépend de la paie |

### B6 — Paie

**Le seul bloc où « ne pas remplacer » reste défendable.** La paie construction au Québec
(CCQ, conventions collectives, taux par métier et par région, avantages sociaux) est un
domaine à part entière. Manœuvre a déjà les **heures** (`SaisieHeure`) ; garder un moteur de
paie tiers et n'importer que le résultat (`ImportRapportPaie` existe déjà pour ça) est plus
sain que de le réécrire.

---

## 5. Ce qu'il faut obtenir d'Avantage avant de commencer

Voir la section 8 de `AVANTAGE-MODELE-DONNEES.md`. En résumé et par ordre d'urgence :

1. **Export complet de toutes les tables** — `xlsx-converter.js` en ignore une partie ; il logue les onglets écartés, récupérer cette liste
2. **Plan comptable GL complet**
3. **Plan d'activités complet** (`ACTIVE`, 1 089 lignes)
4. **Codification des statuts** `CONTRA.COSTT`
5. **`PYBACM` et `ACHAT`** — deux tables jamais analysées faute d'export
6. **Trois exercices clos** pour valider tout balancement contre les états financiers réels

Sans le point 6, aucun basculement de la Phase B n'est vérifiable.

---

## 6. Séquence recommandée

| Étape | Contenu | Dépendance |
|---|---|---|
| 0 | Export complet Avantage + inventaire des tables manquantes | — |
| 1 | `DivisionActivite` + normalisation des codes | 0 |
| 2 | Correction des défauts hérités (A1) | 1 |
| 3 | Migration des 1 291 projets et de leurs budgets | 1 |
| 4 | Bascule saisie native, un flux à la fois (A3) | 2, 3 |
| 5 | Bridge en mode réconciliation, arrêt des écritures | 4 |
| 6 | **Décision Go/No-Go sur la Phase B**, avec le comptable externe | 5 |
| 7 | Grand livre, périodes, états financiers (B1–B4) | 6 |
| 8 | Déclarations réglementaires (B5) | 7 |
| 9 | Paie : intégration d'un moteur tiers, pas réécriture (B6) | 7 |

**Avantage reste le livre officiel jusqu'à l'étape 7 incluse.** Il n'y a aucun moment où
CRC se retrouve sans système comptable.
