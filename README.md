# avantage-bridge

Pont de synchronisation **Avantage ACCEO → Manœuvre (Base44)** pour Construction Richard Champagne.

Sens unique : Avantage reste la source de vérité comptable, Manœuvre en reçoit une copie de
travail. Aucune écriture n'est faite vers Avantage.

## Démarrage

```bash
npm install
cp .env.example .env      # renseigner API_KEY et BASE44_API_KEY
npm start
npm test
```

## Exports Avantage attendus

Les fichiers sont déposés dans `exports-avantage/` (ou le répertoire pointé par `EXPORT_DIR`).

| Fichier | Alimente |
|---|---|
| `CONTRA.csv` | Projets |
| `FACTMA.csv` | Factures client |
| `CONPRE.csv` | Budget de **coûts** par activité |
| `CONFIT.csv` | Budget de **revenus** par activité — **requis pour la marge** |
| `CONACT.csv` | Facturé et dépense à venir par activité |
| `TRANS.csv` | Coûts réels |
| `COMITE.csv` | Rattachement commande → activité |
| `PYBBIL.csv` | Factures fournisseurs |
| `ACTIVE.csv` | Libellés d'activité |
| `export.xlsx` | Bons de commande (feuille `COMMAN`) |

`GET /api/status` liste ces fichiers, leur présence et leur date — un chiffre de marge ne vaut
que par la fraîcheur de l'export qui l'alimente.

> **CONFIT.csv est le seul export manquant aujourd'hui.** Sans lui, le budget de revenus par
> activité est inconnu et **aucune marge n'est calculable** : le bridge remonte alors des coûts
> et une prévision, mais pas de marge. C'est l'export à ajouter en priorité côté Avantage
> (colonnes attendues : `CICONUM` projet, `CIANUM` activité, `CIDP` demande de paiement,
> `CIREV` revenu — seule la dernière DP est retenue).

## Routes

Toutes les routes sauf `/api/status` exigent l'en-tête `x-api-key`.

| Méthode | Route | Effet |
|---|---|---|
| `GET` | `/api/status` | État du service et fraîcheur des exports |
| `GET` | `/api/marge` | **Vue portefeuille** — tous les projets triés par marge croissante |
| `GET` | `/api/marge/:code` | Détail d'un projet, divisions triées par marge croissante |
| `GET` | `/api/budget/preview/:code` | Aperçu de ce qui serait écrit — **n'écrit rien** |
| `POST` | `/api/budget/sync/:code` | Calcule et écrit dans `ControleBudgetaire` |
| `POST` | `/api/bc/sync-bc/:code` | Bons de commande |
| `POST` | `/api/trans/sync-trans/:code` | Transactions |

Paramètre `?methode=budget` (défaut) ou `?methode=engagement` — voir *Prévision à terminaison*.

Ventilation manuelle des ODC par division au `POST /api/budget/sync/:code` :

```json
{ "odc": { "16000": 25000, "03000": 8000 } }
```

## Calcul de la marge

```
coût engagé      = Σ BC max(montant prévu, montant facturé) + dépenses sans BC
engagement restant = max(0, coût engagé − coût réel)
budget non engagé  = max(0, budget révisé − max(coût réel, coût engagé) − dépense à venir)

ETC (méthode budget)     = engagement restant + dépense à venir + budget non engagé
ETC (méthode engagement) = engagement restant + dépense à venir

prévision à terminaison (EAC) = coût réel + ETC
marge projetée                = budget de revenus − prévision à terminaison
```

**Deux méthodes, jamais une seule.** `budget` suppose que le budget résiduel sera dépensé
(conservateur, à utiliser en cours de chantier). `engagement` ne compte que ce qui est
réellement engagé (réaliste en clôture, quand le résiduel ne sera jamais dépensé). Chaque
ligne retournée porte sa `prevision_methode` ainsi que `prevision_engagement_seul`, pour que
la méthode retenue soit toujours lisible.

Seuils d'écart repris du contrôle budgétaire CRC : 🟢 ≤ 3 % · 🟡 3–8 % · 🔴 > 8 %.

## Deux règles de sûreté

1. **Une source absente n'écrit jamais 0.** `budget_revenus` est omis du payload quand
   `CONFIT.csv` manque, plutôt qu'écrasé par un zéro qui effacerait une saisie manuelle.
2. **Un revenu inconnu n'est pas une marge de 0 %.** `marge_projetee` vaut `null`, et le projet
   est classé à part dans la vue portefeuille au lieu d'apparaître en alerte rouge.

## Limite connue

`DirectiveChantier` ne porte pas de `code_division` dans Manœuvre : les ODC ne peuvent pas être
ventilés automatiquement par division. Ils sont totalisés au niveau projet, et
`POST /api/budget/sync/:code` signale dans `avertissements` tout ODC non ventilé. La ventilation
manuelle passe par le corps de la requête (voir plus haut).
