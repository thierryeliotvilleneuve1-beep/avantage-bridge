# Avantage ACCEO — Rétro-ingénierie du modèle de données

> Document de référence reconstruit **uniquement** à partir du code du bridge
> (`src/`, `diag*.js`, `sync-*.js`, `write-*.js`, `verify-p23020.js`) et du skill
> `avantage-bridge-deploy`. Chaque affirmation porte un niveau de confiance :
> **[V]** vérifié par du code qui tourne en production sur des données réelles,
> **[D]** déduit d'un script de diagnostic ponctuel,
> **[H]** hypothèse à valider contre un export réel.
>
> Projet témoin de toute la rétro-ingénierie : **P23020 — Caserne Wemotaci**
> (`projet_id` Base44 : `68cebd8d2e50479c494565ea`).

---

## 1. Nature du système

| Caractéristique | Constat | Conf. |
|---|---|---|
| Éditeur / produit | ACCEO Solutions — **Avantage** (comptabilité de construction) | [V] |
| Hébergement | Serveur Windows local CRC, données sur le lecteur réseau `A:\AVA01` | [V] |
| Architecture | **Fichiers plats** de type AS/400 — pas de SGBD relationnel accessible | [V] |
| API | **Aucune.** Zéro point d'intégration programmatique | [V] |
| Seule sortie | `Utilitaires → Exportation → Excel` → un `export.xlsx` multi-onglets, **déclenché à la main** | [V] |
| Encodage | **latin1 / CP1252** (tous les `readFileSync(..., 'latin1')`) | [V] |
| Flux entrant | Format **ADX** évoqué pour un futur flux BC inverse Manœuvre → Avantage | [H] |

**Conséquence structurante :** Avantage est un système **fermé, en lecture seule et
non temps réel**. Tout ce que le bridge fait aujourd'hui repose sur un export manuel
converti en CSV (`xlsx-converter.js`). C'est le premier point qu'un remplacement
supprime, pas un point à répliquer.

---

## 2. Conventions de données Avantage

Ces règles se répètent dans toutes les tables et sont la principale source de bugs
dans le bridge. Elles doivent être **normalisées à l'import**, jamais reproduites.

| Convention | Détail | Conf. |
|---|---|---|
| Nom de table | 6 lettres majuscules (`CONTRA`, `PYBBIL`, `COMITE`…) | [V] |
| Nom de champ | Préfixe 2 lettres de la table + mnémonique (`CO`+`NUM`, `FF`+`SOLDE`) | [V] |
| N° de projet | Chaîne **paddée à 10 chiffres** : `23020` → `0000023020` | [V] |
| N° de commande | **9 chiffres** dans `COMMAN`/`COMITE`, **7 chiffres** dans `PYBBIL` → jointure impossible sans `padStart(9,'0')` | [V] |
| Code d'activité | 5 chiffres, parfois **suffixé `.00`** (`06100` vs `06100.00`) | [V] |
| Décimales | Virgule **ou** point selon la colonne → `replace(',', '.')` systématique | [V] |
| Dates | `AAAA/MM/JJ` → converties en `AAAA-MM-JJ` | [V] |
| Colonnes | Libellés français accentués **instables entre versions** → le bridge finit par lire **par position d'index**, pas par nom | [V] |

> Le passage de la lecture par en-tête (`columns: true`) à la lecture par position
> (`columns: false` + index numériques) est visible dans l'historique `write-trans-sync-v2` → `v10`.
> C'est un aveu : **les en-têtes d'export Avantage ne sont pas fiables.**

---

## 3. Les 12 tables identifiées

| Table | Rôle métier | Préfixe | Volume CRC | Conf. |
|---|---|---|---|---|
| `CONTRA` | Maître des **projets / contrats** | `CO` | 1 291 lignes | [V] |
| `CONPRE` | **Budget prévisionnel** par activité | `CP` | 8 078 lignes | [V] |
| `CONACT` | **Cumuls réels** par activité (facturé, à venir) | `CA` | 6 485 lignes | [V] |
| `ACTIVE` | **Plan de comptes analytique** (divisions/activités) | `A` | 1 089 lignes | [V] |
| `FACTMA` | **Factures clients** (comptes-clients / AR) | `FF` | 219 lignes | [V] |
| `COMMAN` | **En-têtes de bons de commande** | – | n/d | [V] |
| `COMITE` | **Lignes de bons de commande** (BC → activité) | – | n/d | [V] |
| `ACHAT` | Achats / engagements fournisseurs | – | n/d | [D] |
| `PYBBIL` | **Factures fournisseurs** (comptes-fournisseurs / AP) + ventilation GL | – | n/d | [V] |
| `PYBACM` | Paiements / acomptes fournisseurs | – | n/d | [H] |
| `TRANS` | **Grand livre analytique** — toute transaction répartie projet × activité | – | n/d | [V] |
| `SAISIE` | **Saisie des heures** (paie / main-d'œuvre) | – | n/d | [V] |

---

## 4. Dictionnaire de données, table par table

### 4.1 `CONTRA` — Projets / contrats  [V]

Source : `src/parsers/parseContra.js`

| Champ | Signification | Type |
|---|---|---|
| `CONUM` | N° de projet (10 chiffres paddés) — **clé primaire** | texte |
| `CONOM` / `CONOMS` | Nom du projet (long / court) | texte |
| `COCLI` / `COCLINOM` | Code client / nom du client | texte |
| `COSTT` | Statut du contrat | code |
| `COFADATER` | Date de début réelle | date |
| `COFADATEP` | Date de fin prévue | date |
| `COSOLDER` | Montant du contrat / solde | montant |
| `COPRCPROF` | Coût réel / profit | montant |

### 4.2 `CONPRE` — Budget prévisionnel par activité  [V]

Source : `src/routes/budget.js`, `sync-p23020.js`

| Champ | Alias export | Signification |
|---|---|---|
| `CPCONUM` | « Numéro du projet » | N° de projet → `CONTRA.CONUM` |
| `CPACT` | « Code d'activité » | Code d'activité → `ACTIVE` |
| `CPMNT` | « Montant prévisionnel » | Budget alloué à cette activité |

**Grain :** une ligne par (projet × activité). C'est le **budget de contrôle** de CRC.
Pour P23020 : 58 activités budgétées.

### 4.3 `CONACT` — Cumuls par activité  [V]

Lu **par position** dans le bridge v7 :

| Index | Champ | Signification |
|---|---|---|
| `[0]` | `CACONUM` | N° de projet |
| `[1]` | `CAANUM` | Code d'activité |
| `[2]` | — | Pourcentage d'avancement |
| `[3]` | `CAVENIR` | Dépense à venir (reste à engager) |
| `[4]` | `CAFACT` | « Achat facturé (T/F) » — **facturé à date** |

⚠️ **Piège documenté :** le libellé `CAFACT` est ambigu. Le bridge l'a d'abord pris
pour la dépense réelle, puis l'a réinterprété comme **revenu client par activité**
(commentaire `[4]=facture_a_date (revenus client)` dans `budget.js`), et a fini par
**abandonner `CONACT` comme source de dépenses** au profit de `TRANS`.
Dans l'export témoin `avantage-conact-p23020.txt`, `DepenseAvenir` vaut `0.00`
sur les 58 divisions — le champ n'est pas alimenté chez CRC.

### 4.4 `ACTIVE` — Plan de comptes analytique  [V]

| Index | Champ | Signification |
|---|---|---|
| `[0]` | `ANUM` | Code d'activité (5 chiffres) — **clé** |
| `[1]` | `ANOM` | Description française |
| `[2]` | `ANAM` | Description anglaise |

**Structure du plan** (déduite des 58 divisions réelles de P23020) : **MasterFormat 1995
à 16 divisions**, plus deux séries maison.

| Plage | Nature | Exemples réels P23020 |
|---|---|---|
| `00100`–`00401` | Conditions générales, administration de chantier | `00100`, `00400`, `00401` |
| `02xxx` | Travaux de site | `02300`, `02335`, `02510`, `02740`, `02775`, `02920` |
| `03xxx` | Béton | `03000`, `03530` |
| `05xxx` | Métaux | `05500` |
| `06xxx` | Bois et plastiques | `06100`, `06110`, `06170`, `06180`, `06400` |
| **`06101`** | **Main-d'œuvre CRC** — traitée à part (`MO_CODES`) | — |
| `07xxx` | Isolation / étanchéité | `07000`, `07330`, `07460` |
| `08xxx` | Portes et fenêtres | `08000`, `08120`, `08560` |
| `09xxx` | Finitions | `09200`, `09300`, `09910` |
| `10xxx`–`12xxx` | Spécialités, équipements, ameublement | `10810`, `12500` |
| `15xxx` | Mécanique / plomberie | `15001`, `15100`, `15260`, `15401`, `15410`, `15900`, `15950` |
| `16xxx` | Électricité | `16080`, `16130`, `16150`, `16220`, `16300`, `16500`, `16700`, `16720`, `16800` |
| **`25001`–`25014`** | **Série maison** — frais de gestion / administration de projet | 14 codes actifs sur P23020 |

### 4.5 `FACTMA` — Factures clients (AR)  [V]

Source : `src/parsers/parseFactma.js`

| Champ | Signification |
|---|---|
| `FFNOFACT` | N° de facture — **clé** |
| `FFCONT` | N° de projet (→ `CONTRA.CONUM`) |
| `FFVENTE` / `FFNOM` | Client |
| `FFDATE` | Date de facture |
| `FFDATEP` | Date d'échéance |
| `FFTOTDU` | Total dû |
| `FFSOLDE` | Solde ouvert (`> 0` ⇒ statut « ouvert », sinon « payé ») |
| `FFMNTRET` | **Montant de retenue contractuelle** |

### 4.6 `COMMAN` — En-têtes de bons de commande  [V]

Source : `src/routes/bc-sync.js`. Lu par libellé de colonne (recherche par fragment) :

| Libellé (fragment recherché) | Signification |
|---|---|
| « …quentiel » (sans « commande ») | N° séquentiel de la ligne |
| « …quentiel de commande » | **N° séquentiel de commande (9 ch)** — clé de jointure |
| « num…fournisseur » | N° du fournisseur |
| « Nom du fournisseur » | Raison sociale |
| « sous-total » | Montant du BC (hors taxes) |
| « …ception » | Date de réception |
| « statut » | **`0` = ouvert**, toute autre valeur = fermé |
| « projet » | N° de projet (10 ch paddés) |

### 4.7 `COMITE` — Lignes de bons de commande  [V]

Lu par position (v10) :

| Index | Signification |
|---|---|
| `[16]` | N° séquentiel de commande (9 chiffres) |
| `[17]` | **Code d'activité** de la ligne |

> Historique : la v8 lisait `[20]` pour l'activité, corrigé en `[17]` en v9.
> Une commande peut couvrir plusieurs activités ; le bridge ne retient que **la première**
> (`if (!map[cmd]) map[cmd] = act`) — **perte d'information assumée**, à corriger dans un remplacement.

`COMITE` est **le seul chemin** qui relie une facture fournisseur à une division budgétaire.

### 4.8 `PYBBIL` — Factures fournisseurs (AP) + ventilation GL  [V]

La table la plus riche. Lue **entièrement par position** :

| Index | Signification |
|---|---|
| `[0]` | N° séquentiel de la facture — **clé** (préfixée `P` dans Manœuvre) |
| `[1]` | Date du compte |
| `[2]` | N° du fournisseur |
| `[4]` | N° de facture du fournisseur |
| `[5]` | Description |
| `[6]` | Montant total du compte (**taxes incluses**) |
| `[8]`,`[9]` … `[26]`,`[27]` | **10 paires (compte GL, montant)** — ventilation comptable de la facture |
| `[33]` | N° de projet |
| `[44]` | N° de commande (**7 chiffres**) |
| `[48]` | Nom du fournisseur |

**Ventilation GL — règle du montant net** (`getMontantNet`, v10) :

```
montant_net = Σ montant[i] pour chaque paire où GL[i] ∉ {21340, 21370, 21310, 21300}
si montant_net == 0 → repli sur [6] (montant total)
```

| Compte GL | Rôle | Conf. |
|---|---|---|
| `21300`, `21310`, `21340`, `21370` | **Comptes de taxes** (TPS / TVQ, à payer / à recevoir) — exclus du coût projet | [V] |
| `33200` | Comptes fournisseurs projet — GL par défaut écrit dans Manœuvre | [V] |

### 4.9 `TRANS` — Grand livre analytique  [V]

**Source de vérité des dépenses réelles** depuis la v7 du bridge.

| Index | Signification |
|---|---|
| `[0]` | N° de projet |
| `[1]` | N° de compte GL |
| `[2]` | Date |
| `[3]` | **Type + n° de journal** — la 1ʳᵉ lettre porte le type |
| `[4]` | **Montant réparti** |
| `[5]` | **Code d'activité** |

**Typologie des transactions** (1ʳᵉ lettre de `[3]`) :

| Type | Nature | Traitement bridge |
|---|---|---|
| `R` | **Comptes-clients** — revenus | **Exclu** du coût de projet |
| `P` | **Comptes-fournisseurs** — payables | Inclus dans `engage` |
| `E` | **Écriture salariale** — main-d'œuvre | Inclus dans `mo_total`, `is_mo = true` |
| `B` | **Transaction bancaire** | Inclus dans `engage` |

### 4.10 `SAISIE` — Heures / main-d'œuvre  [V]

Source : `sync-mo-p23020.js`. Colonnes trouvées par fragment de libellé :

| Fragment | Signification |
|---|---|
| « activit » | Code d'activité imputé |
| « Taux de salaire » | Taux horaire de l'employé |
| « heures r… » | Heures régulières |
| « temps + » | Heures supplémentaires (×1,5) |
| « temps x 2 » | Heures doubles (×2) |

**Formule de coût MO :**
```
coût_MO = taux × (h_régulières + 1,5 × h_supplémentaires + 2 × h_doubles)
```
> Le repérage des lignes d'un projet se fait par `Object.values(r).some(v => v === '0000023020')` —
> aucune colonne projet fiable n'a été trouvée dans `SAISIE`. **À valider.**

### 4.11 `ACHAT` — Achats / engagements  [D]

Sondé par `sync-bc-p23020.js`. Colonnes détectées par fragment : « projet », « fournisseur »,
« commande », « …ception » (date), « sous-total », « activit ». Sert d'alternative à
`COMMAN`+`COMITE` : **contient déjà le code d'activité**, donc pas besoin de la jointure `COMITE`.
Piste à privilégier lors d'une migration.

### 4.12 `PYBACM`  [H]

Sondé par `diag10.js`, jamais exploité. Nom cohérent avec **PY**(payables) **AC**(acomptes) —
probablement les paiements/décaissements fournisseurs. **Non analysé faute d'export.**

---

## 5. Le graphe de jointure Avantage

```
                          ACTIVE (ANUM → nom de division)
                             ▲
                             │ code d'activité
        ┌────────────────────┼────────────────────────────┐
        │                    │                            │
   CONPRE (budget)      COMITE [17]                  TRANS [5]
   CPCONUM/CPACT/CPMNT   [16] n° cmd 9 ch          [0]projet [1]GL
        │                    ▲                     [3]type [4]montant
        │                    │ padStart(9,'0')            │
        │               COMMAN (en-tête BC)               │
        │                    ▲                            │
        │                    │ n° cmd                     │
        │               PYBBIL [44] n° cmd 7 ch           │
        │               [33]projet [8..27] ventilation GL │
        │                    │                            │
   CONTRA.CONUM ◄────────────┴────────────────────────────┘
        │  (n° de projet, 10 chiffres paddés)
        ├─── CONACT (cumuls facturé / à venir)
        ├─── FACTMA.FFCONT (factures clients)
        └─── SAISIE (heures, via recherche brute du n° projet)
```

**Le point faible du modèle :** une facture fournisseur (`PYBBIL`) **n'a pas de code
d'activité**. Elle ne peut être imputée à une division que si elle porte un n° de commande
qui existe dans `COMITE`. Une facture sans BC est **orpheline** — c'est exactement pourquoi
`budget.js` construit des « phases extra » à partir de `TRANS` pour les activités qui ont
des dépenses mais aucun budget `CONPRE`.

---

## 6. Règles de gestion extraites (à reproduire ou à corriger)

| # | Règle | Statut pour un remplacement |
|---|---|---|
| 1 | Les revenus (`TRANS` type `R`) sont exclus du coût de projet | **Reproduire** |
| 2 | La MO (activité `06101`, `TRANS` type `E`) est comptabilisée séparément de l'engagé | **Reproduire** |
| 3 | Les taxes (GL 213xx) sont exclues du coût de projet | **Reproduire** |
| 4 | `récupération / pertes = engagé + MO − budget` | **Reproduire** |
| 5 | `% d'avancement coût = (engagé + MO) / budget × 100` | **Reproduire** |
| 6 | Retenue contractuelle suivie au niveau facture client (`FFMNTRET`) | **Reproduire et étendre** (retenue fournisseur absente d'Avantage) |
| 7 | Un BC multi-activités n'est imputé qu'à sa **première** activité | **Corriger** — ventiler par ligne |
| 8 | Facture fournisseur sans BC = non imputable à une division | **Corriger** — imputation directe à l'activité |
| 9 | Largeurs de n° de commande incohérentes (7 vs 9) | **Corriger** — identifiant unique |
| 10 | `CONACT.CAVENIR` (dépense à venir) non alimenté chez CRC | Fonction à **reconstruire** proprement (EAC) |

---

## 7. Ce qu'Avantage fait qui n'est **pas** visible dans le bridge

Le bridge ne touche que la **comptabilité de projet**. Un remplacement doit aussi couvrir
ces fonctions, dont aucune trace n'existe dans ce dépôt et qui doivent être inventoriées
directement dans l'application avant tout chantier :

- Grand livre général, journaux, fermeture de période et d'exercice
- États financiers (bilan, résultats, flux de trésorerie)
- Déclarations : TPS/TVQ, DAS, **T5018 (contrats de sous-traitance)**, CCQ
- Paie complète (feuillets T4 / RL-1, retenues, avantages imposables)
- Immobilisations et amortissement
- Rapprochement bancaire réel, conciliation des comptes
- Gestion des fournisseurs / clients (fiches maîtres, conditions, historiques)

> **Ces fonctions sont réglementées et vérifiables par un comptable externe.**
> Elles constituent le vrai coût d'un remplacement, pas le contrôle budgétaire.

---

## 8. Inventaire à produire avant de coder

Ce document est reconstruit à partir d'un unique projet témoin. Pour bâtir un remplacement,
il faut d'abord un **export complet** :

1. Export Avantage de **toutes** les tables, pas seulement les 11 du `MAPPING` de `xlsx-converter.js`
   (le script logue les onglets ignorés — récupérer cette liste).
2. Dump de `PYBACM` et `ACHAT` sur 3 projets clos, pour trancher leur rôle.
3. Le **plan de comptes GL complet** — seuls 5 comptes sont connus (21300/21310/21340/21370/33200).
4. Le **plan d'activités complet** (`ACTIVE`, 1 089 lignes) — aujourd'hui utilisé comme simple
   table de libellés, jamais exporté ni versionné.
5. La liste des **1 291 projets** de `CONTRA` avec leurs statuts (`COSTT`) — la codification
   des statuts est inconnue.
6. Trois exercices financiers clos, pour valider tout balancement contre les états financiers réels.
