# Bridge Avantage → Manœuvre — Déploiement et gestion (v7.3)

> Mise à jour majeure septembre 2026. Remplace la version v7 basée sur l'export CSV.
> Le bridge lit maintenant la **base Avantage en direct** et reconstruit le contrôle
> budgétaire complet dans Manœuvre, au cent près, sans ACCEO ni SDK.

## Contexte CRC

- **Système comptable** : Avantage ACCEO, serveur Windows local, données sur `A:\AVA01`.
- **Moteur de BD** : **Visual FoxPro** — fichiers `.DBF` (+ index `.cdx`, mémos `.fpt`).
  Ce ne sont PAS des exports : ce sont les tables elles-mêmes, toujours à jour.
- **ERP cible** : Manœuvre (Base44, app ID `68927e133cde9f63295dd616`).
- **Bridge** : Node.js + PM2, dans `C:\Users\thierry\avantage-bridge`.
- **Dépôt GitHub** : `thierryeliotvilleneuve1-beep/avantage-bridge`, branche déployée
  **`claude/reduction-entreprise-scenario-2gc7xf`**.

## Découvertes clés (ne pas refaire l'enquête)

1. **La BD Avantage est du FoxPro `.DBF`**, lisible directement, PAS du Pervasive/ODBC.
   Le lecteur maison `src/db/lecteurDbf.js` décode l'en-tête et les enregistrements
   (il ignore l'octet de version — Avantage met une valeur non standard « 6 »).
2. **Deux tables sont CHIFFRÉES par Avantage** : `CONTRA` (projets, noms, clients) et
   `FACTMA` (factures client). Un champ `CRYPTED` le confirme, le contenu est binaire.
   → Impossible à lire en direct. On les contourne (voir plus bas). Ce n'est PAS un bug.
3. **ACCEO n'offre pas de service** pour le SDK. Le SDK (requêtes `.txt`/TCP `R01`/`W04`…)
   existe mais le guide des requêtes n'est pas fourni et le support est absent. **Écarté.**
4. **Ne jamais casser le chiffrement** : contournement légitime uniquement.

## Tables lisibles vs chiffrées

| Donnée | Table `.DBF` | État |
|---|---|---|
| Budget par division | `CONPRE` (CPCONUM, CPACT, CPMNT, CPPOSTE) | ✅ lisible |
| Facturé + coûts à venir + profit / division | `CONACT` (CACONUM, CAANUM, CAFACT, CAVENIR, CAPROFIT) | ✅ lisible |
| Grand livre projet (dépense, engagé) | `TRANS` (TCONUM, TNOGL, TNOSEQ, TMNT, TANUM) | ✅ lisible |
| Factures fournisseurs (ventilation) | `PYBBIL` | ✅ lisible |
| Commande → division | `COMITE` (CINOCMD/…, activité) | ✅ lisible |
| Activités (noms de divisions) | `ACTIVE` | ✅ lisible |
| **Projets (noms, clients)** | `CONTRA` | ❌ **chiffré** |
| **Factures client** | `FACTMA` | ❌ **chiffré** |

## Modèle du contrôle budgétaire (reproduit l'écran « Suivi de projet » d'Avantage)

Par division, tout est reconstruit depuis les tables lisibles :

- **Budget de coûts** = Σ `CONPRE.CPMNT` par activité.
- **Dépense** (argent réellement sorti) = Σ `TRANS.TMNT` des journaux **P, E, B** par activité
  (exclut comptes de produits `31xxx` et taxes `21300/21310/21340/21370`).
- **Main-d'œuvre** = Σ `TRANS` journal **E** par activité.
- **Coûts engagés** (contrats octroyés) = Σ `TRANS` journal **C** par activité.
- **Facturé** = `CONACT.CAFACT` par activité.
- **Coûts à venir** = `CONACT.CAVENIR`.
- **Budget de revenus** = budget de coûts + profit, où profit = `CONACT.CAPROFIT` s'il
  est saisi, sinon **markup standard 10 %** (`AVANTAGE_TAUX_PROFIT`, l'en-tête Avantage
  affiche « Profit calculé sur : Les coûts 10.00 % »). Le taux par contrat vit dans
  `CONTRA` (chiffré), d'où le paramètre.

Journaux `TRANS` écartés : **R** (produits → revenus), **P** en double de PYBBIL au besoin,
**X** (exceptions). Validé au cent près contre l'écran Avantage du projet 26004.

## Mapping vers l'entité `ControleBudgetaire` (Manœuvre)

Le bridge écrit **seulement** les champs dont Avantage est la source de vérité, et
**préserve** les champs calculés par Manœuvre (`cout_engage`) et les saisies manuelles
(directives, avenants, décomptes) :

| Champ Manœuvre | Source Avantage |
|---|---|
| `montant_initial` | budget de coûts (CONPRE) |
| `depense` *(champ + colonne ajoutés en sept. 2026)* | dépense réelle (TRANS P/E/B) |
| `engage` | coûts engagés (TRANS journal C) |
| `mo_total` | main-d'œuvre (TRANS journal E) |
| `budget_revenus` | budget coûts + profit |
| `facture` | CONACT.CAFACT |

La colonne « Dépense » (ambre) a été ajoutée au tableau
`src/components/controle-budgetaire/TableauControleBudgetaire.jsx` de l'app Manœuvre,
entre Budget et Engagé PO (11 → 12 colonnes ; colSpans ajustés).

## Détail des transactions par division (sections drill-down)

Chaque division du tableau ouvre trois sections qui lisent `TransactionAvantage` :

- **Transactions Avantage sans BC** (`TransactionsAvantageDrilldown.jsx`) filtre
  `controle_budgetaire_id === divisionId` **et** `bon_de_commande_id` vide.
- **Bons de commande** liste les entités `BonDeCommande` du projet.
- **Main-d'œuvre** (`MODrilldownAvantage.jsx`, ajouté sept. 2026) : affiche d'abord les
  **écritures de paie E d'Avantage** de la division (les `TransactionAvantage` avec
  `type_transaction === 'E'` / `is_mo`), qui sont la source du total MO (`mo_total` =
  TRANS journal E), puis les saisies `SaisieHeure` (TempoBuild) en dessous.
  Le total MO de `ControleBudgetaireTab` = **Avantage seulement** (`mo_total = mo_avantage`,
  journal E = paie réellement versée, vérité comptable). `mo_local` (heures TempoBuild ×
  taux) reste calculé pour le détail mais n'est PAS additionné au total, pour éviter le
  double compte des heures présentes dans Avantage ET TempoBuild (décidé sept. 2026).

**Attribution de division des factures fournisseurs sans BC** (corrigé sept. 2026) :
une facture `PYBBIL` sans bon de commande n'a pas de division propre. On la rattache
au **journal P homologue dans `TRANS`**, qui porte le code d'activité (`TANUM`).
`depotDbf.divisionParJournalP()` construit `journal 'P######' → activité dominante`
(par montant) et `syncAvantage` l'utilise en repli après le rattachement par BC
(`commandeDiv[commande] || journalDiv[journal]`). Sans ce repli, ces transactions
arrivaient avec `code_division` vide → `controle_budgetaire_id` nul → la section
« sans BC » restait vide. Le n° de journal PYBBIL (`'P'+PBF00`) et le `TNOSEQ` de TRANS
partagent la même chaîne.

**Bons de commande** : l'entité `BonDeCommande` vient de la table `COMMAN` (en-tête de
commande). La route historique `/api/bc/sync-bc/:code` la lit encore depuis l'export
Excel — à remplacer par un lecteur `.DBF` direct une fois la structure de `COMMAN`
cartographiée via `/api/inspect/COMMAN` (voir routes). Tant que les `BonDeCommande` ne
sont pas synchronisés, la section « Bons de commande » d'une division reste vide même
si les transactions, elles, sont bien attribuées.

## Contournement des tables chiffrées

- **Projets** : dérivés du numéro de projet porté EN CLAIR par les transactions.
  Le bridge **ne crée aucun projet** ; il synchronise uniquement les projets **déjà
  présents dans Manœuvre** (créés par l'équipe). Les projets clos de l'historique
  (≈ 1251) sont ignorés proprement.
- **Factures client / noms de projets** : non lisibles en direct. Si nécessaires, un
  **export CSV ponctuel** de CONTRA/FACTMA depuis Avantage (déchiffré à l'export) déposé
  dans `exports-avantage\` est lu automatiquement en repli.

## Architecture du code (branche reduction-entreprise-scenario)

```
src/db/lecteurDbf.js            Lecteur .DBF FoxPro (en-tête + enregistrements)
src/sources/depotDbf.js         Lectures haut niveau (charges, écritures, projets…)
src/sources/donneesAvantage.js  Orchestrateur DBF → (ODBC) → CSV, auto-mappage colonnes
src/sources/syncAvantage.js     Assemble projets / factures / transactions par projet
src/sources/budgetDbf.js        Aperçu budgétaire par division (CONPRE/TRANS/CONACT)
src/services/syncBudgetControle.js  Écrit ControleBudgetaire (différentiel)
src/services/pousseurTransactions.js Écrit TransactionAvantage (différentiel)
src/services/syncComplet.js     Cycle complet : projets → factures → budget → transactions
src/writers/base44-writer.js    GET paginé + upsert + différentiel (inchange)
```

## Déploiement / mise à jour

```powershell
cd "C:\Users\thierry\avantage-bridge"
git pull origin claude/reduction-entreprise-scenario-2gc7xf
npm install
pm2 restart avantage-bridge --update-env
pm2 save
```

### `.env` (valeurs à ne PAS committer — placeholders ici)
```
PORT=3000
API_KEY=<clé-secrète-longue-du-bridge>
BASE44_API_KEY=<clé-api-base44>
BASE44_APP_ID=68927e133cde9f63295dd616
AVANTAGE_DBF_DIR=A:\AVA01
AVANTAGE_TAUX_PROFIT=0.10
CRON_ACTIF=true
CRON_SCHEDULE=*/15 * * * *
```

## Routes API (en-tête `x-api-key` sauf /api/status)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/status` | Version, source, fraîcheur |
| GET | `/api/sync/etat` | Détail du dernier sync |
| POST | `/api/sync/all` | Sync complet de tous les projets actifs (différentiel) |
| POST | `/api/sync/projet/:code` | Sync complet d'un projet |
| GET | `/api/budget/apercu/:code` | **Aperçu lecture seule** du contrôle budgétaire (validation) |
| GET | `/api/inspect/:table?n=5` | **Inspection lecture seule** d'une table `.DBF` (colonnes, lisibilité, échantillon) — pour cartographier `COMMAN` etc. |
| POST | `/api/trans/sync-trans/:code` | Transactions seulement |

Commandes PowerShell (clé lue depuis .env) :
```powershell
$key = (Select-String '^API_KEY=' .env).Line.Split('=')[1]
curl.exe -X POST -H "x-api-key: $key" "http://localhost:3000/api/sync/all"
curl.exe "http://localhost:3000/api/budget/apercu/P26004" -H "x-api-key: $key"
```
⚠️ Coller la commande curl **seule** sur sa ligne (sinon PowerShell mélange avec `$key`).

## Sync différentiel

Chaque cycle ne réécrit que ce qui a changé (comparaison champ par champ, tolérance 0,005 $).
Le premier chargement écrit tout ; ensuite le cron (15 min) n'entretient que le différentiel.
`CRON_ACTIF=false` met le sync auto en pause (utile pour un chargement initial contrôlé).

## Diagnostics

- **Manœuvre ne bouge pas** : vérifier `pm2 status` (online), `.env` présent (sinon
  `api_key undefined`), `AVANTAGE_DBF_DIR` pointe sur `A:\AVA01`, `curl /api/sync/etat`.
- **Table « illisible/chiffrée »** attendue pour CONTRA/FACTMA — normal.
- **« un sync est déjà en cours »** : le cron tourne ; attendre ou `pm2 restart`.
- Valider les chiffres avec `/api/budget/apercu/:code` contre l'écran Suivi de projet
  d'Avantage AVANT de conclure.

## Résidus connus

- Écart ≈ 1 $ possible sur la dépense de certaines divisions (arrondi isolé).
- Taux de profit par contrat dans `CONTRA` (chiffré) : défaut 10 % via `AVANTAGE_TAUX_PROFIT`.

## Prochaines évolutions possibles

- **Lecteur `.DBF` direct de `COMMAN`** pour synchroniser `BonDeCommande` dans le cycle
  complet (remplace `/api/bc/sync-bc` basé sur Excel). Cartographier d'abord avec
  `/api/inspect/COMMAN`.
- Route de réconciliation listant les écarts BD ↔ Manœuvre au lieu de les écraser.
- Flux inverse (bons de commande Manœuvre → Avantage) si un jour le SDK devient accessible.
