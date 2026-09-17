# Bridge Avantage → Manoeuvre — v7.1

Pousse les données comptables d'Avantage ACCEO vers Manoeuvre (Base44) :
projets, factures client, contrôle budgétaire, bons de commande et transactions.

## Ce que fait le sync automatique

À chaque passage du cron (`CRON_SCHEDULE`, 15 min par défaut) **et** dès qu'un
nouvel `export.xlsx` est déposé dans `exports-avantage/` :

1. `export.xlsx` → CSV (seulement si les CSV sont plus vieux que le classeur) ;
2. `CONTRA.csv` → entité `Projet` ;
3. `FACTMA.csv` → entité `FactureClient` ;
4. pour **chaque projet actif** de Manoeuvre :
   - `CONPRE` + `TRANS` + `CONACT` → `ControleBudgetaire`,
   - `COMMAN` → `BonDeCommande`,
   - `PYBBIL` + `TRANS` (types E et B) → `TransactionAvantage`.

Un projet dont aucune donnée Avantage n'a changé depuis le dernier sync est
sauté (`SKIP_UNCHANGED=true`). Un sync déjà en cours bloque le suivant.

Le bridge ne peut pas être plus à jour que le dernier export Avantage :
la sortie `Utilitaires → Exportation → Excel` reste manuelle. `/api/status`
signale un export périmé au-delà de `MAX_EXPORT_AGE_HOURS`.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/status` | Version, config et **fraîcheur des données** (publique) |
| GET | `/api/sync/state` | Détail du dernier sync |
| POST | `/api/sync/all` | Sync complet de tous les projets actifs |
| POST | `/api/sync/all?force=1` | Idem, en repoussant même l'inchangé |
| POST | `/api/sync/all?projets=P23020,P24011` | Sync complet de projets ciblés |
| POST | `/api/sync/projet/:code` | Sync complet d'un projet |
| POST | `/api/sync/convert` | Conversion `export.xlsx` → CSV seulement |
| POST | `/api/budget/sync/:code` | Contrôle budgétaire seulement |
| POST | `/api/bc/sync-bc/:code` | Bons de commande seulement |
| POST | `/api/trans/sync-trans/:code` | Transactions seulement (`?division=03300`) |

Toutes les routes sauf `/api/status` exigent l'en-tête `x-api-key`.

## Commandes courantes (PowerShell, poste Windows)

```powershell
cd "C:\CRC\avantage-bridge-v7\bridge-v7"

# Forcer un sync complet maintenant
curl.exe -X POST -H "x-api-key: $env:API_KEY" http://localhost:3000/api/sync/all

# Vérifier si Manoeuvre est à jour
curl.exe http://localhost:3000/api/status

# Un seul projet
curl.exe -X POST -H "x-api-key: $env:API_KEY" http://localhost:3000/api/sync/projet/P23020
```

## Configuration

Voir `.env.example`. Variables ajoutées en v7.1 :
`EXPORT_DIR`, `FULL_SYNC_ON_CRON`, `SYNC_PROJETS`, `WATCH_EXPORT`,
`SKIP_UNCHANGED`, `MAX_EXPORT_AGE_HOURS`.

## Tests

```bash
npm test    # sync de bout en bout contre un Base44 simulé, sans réseau
```
