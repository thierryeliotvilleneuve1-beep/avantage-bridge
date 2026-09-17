# Bridge Avantage → Manoeuvre — v7.2

Pousse les données comptables d'Avantage ACCEO vers Manoeuvre (Base44) :
projets, factures client, contrôle budgétaire, bons de commande et transactions.

## Source des données

Deux sources interchangeables derrière la même interface :

| Source | Fraîcheur | Configuration |
|---|---|---|
| **`odbc` — lecture directe de la BD Avantage** (défaut dès qu'un DSN existe) | Temps réel | `ODBC_DSN` ou `ODBC_CONNECTION_STRING` |
| `xlsx` — export Excel manuel | Dépend du dernier export | `EXPORT_DIR` |

En mode `odbc`, le filtre projet est poussé dans le SQL : le bridge ne lit que
les lignes des projets à synchroniser, pas les 180 000 transactions du fichier.
Si la BD est injoignable, le bridge bascule automatiquement sur le dernier
export Excel (`FALLBACK_XLSX=true`) et le signale dans `/api/status`.

### Mise en service de la lecture directe

```powershell
cd "C:\CRC\avantage-bridge-v7\bridge-v7"
npm install                 # installe aussi le module odbc
node discover-db.js         # vérifie la connexion et résout les colonnes
```

`discover-db.js` produit `avantage-db-rapport.json` : tables atteignables,
colonnes disponibles, mapping résolu, colonnes non résolues. Les noms de
colonnes de `CONTRA`, `FACTMA`, `CONPRE`, `CONACT` et `ACTIVE` sont connus ;
ceux de `TRANS`, `PYBBIL`, `COMITE` et `COMMAN` sont résolus par heuristique
et doivent être confirmés par ce rapport, puis figés dans
`src/sources/schema.js`.

## Ce que fait le sync automatique

À chaque passage du cron (`CRON_SCHEDULE`, 15 min par défaut) :

1. lecture des projets et factures client ;
2. résolution des projets actifs dans Manoeuvre ;
3. lecture du détail budgétaire **filtré sur ces projets** ;
4. pour chaque projet : `ControleBudgetaire`, `BonDeCommande`, `TransactionAvantage`.

Un projet dont aucune donnée Avantage n'a changé depuis le dernier sync est
sauté (empreinte MD5, `SKIP_UNCHANGED=true`). Un sync déjà en cours bloque
le suivant. En mode `xlsx`, un nouvel `export.xlsx` déclenche un sync immédiat.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/status` | Version, source active et **fraîcheur des données** (publique) |
| GET | `/api/sync/state` | Détail du dernier sync |
| GET | `/api/sync/source` | Diagnostic de la connexion BD et du mapping des colonnes |
| POST | `/api/sync/all` | Sync complet de tous les projets actifs |
| POST | `/api/sync/all?force=1` | Idem, en repoussant même l'inchangé |
| POST | `/api/sync/all?projets=P23020,P24011` | Sync complet de projets ciblés |
| POST | `/api/sync/projet/:code` | Sync complet d'un projet |
| POST | `/api/sync/convert` | Conversion `export.xlsx` → CSV (mode xlsx) |
| POST | `/api/budget/sync/:code` | Contrôle budgétaire seulement |
| POST | `/api/bc/sync-bc/:code` | Bons de commande seulement |
| POST | `/api/trans/sync-trans/:code` | Transactions seulement (`?division=03300`) |

Toutes les routes sauf `/api/status` exigent l'en-tête `x-api-key`.

## Commandes courantes (PowerShell, poste Windows)

```powershell
cd "C:\CRC\avantage-bridge-v7\bridge-v7"

curl.exe http://localhost:3000/api/status                                    # Manoeuvre est-il à jour ?
curl.exe -X POST -H "x-api-key: $env:API_KEY" http://localhost:3000/api/sync/all
curl.exe -X POST -H "x-api-key: $env:API_KEY" http://localhost:3000/api/sync/projet/P23020
curl.exe -H "x-api-key: $env:API_KEY" http://localhost:3000/api/sync/source  # diagnostic BD
```

## Architecture

```
src/sources/     schema.js, odbc-source.js, xlsx-source.js  → lignes canoniques
src/services/    dataset (index), syncBudget, syncBc, syncTrans, fullSync
src/writers/     base44-writer (pagination + upsert)
src/routes/      sync, budget, bc-sync, trans-sync
```

Les deux sources produisent exactement les mêmes lignes canoniques : c'est
vérifié par un test d'équivalence.

## Tests

```bash
npm test    # source Excel + source BD (pilote ODBC simulé), sans réseau
```
