# État des résultats interactif — bridge Avantage

État des résultats de CRC lu **directement dans Avantage**, avec drill-down jusqu'à la
facture et simulateur de réduction des frais généraux.

## Garantie de lecture seule

Le bridge **n'écrit jamais** dans la comptabilité Avantage.

- `src/db/connexion.js` n'expose qu'une fonction d'interrogation, et elle refuse tout ce
  qui n'est pas un `SELECT` ou un `WITH`. Les mots-clés `INSERT`, `UPDATE`, `DELETE`,
  `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `MERGE`, `GRANT`, `REVOKE`, `EXEC` et `CALL`
  provoquent un rejet avant que la requête n'atteigne le pilote ODBC.
- Aucun chemin d'écriture vers Avantage n'existe dans le code.
- La connexion est ouverte sans transaction d'écriture.
- `AVANTAGE_BD_ACTIVE` est à `false` par défaut : sans action explicite, le bridge ne
  touche même pas à la base.
- Les routes de ce module ne répondent qu'aux `GET`.

Cinq tests vérifient ces refus (`npm test`).

> Les routes de synchronisation existantes (`/api/budget`, `/api/bc`, `/api/trans`)
> écrivent dans Base44, jamais dans Avantage. Ce module-ci n'écrit nulle part.

## Utilisation

```bash
npm install
npm start
```

Ouvrir dans le navigateur :

```
http://localhost:3000/api/etat-resultats/vue?key=VOTRE_CLE_API
```

### Ce que l'écran permet

| Action | Effet |
|---|---|
| Choisir une période | Dates libres, ou raccourcis 12 mois / année en cours / année précédente / 3 mois |
| Cliquer une ligne | Descend d'un niveau : **poste → compte GL → fournisseur → facture** |
| Saisir un % dans « Réd. % » | Simule une coupe sur ce poste et recalcule en direct le résultat net, le seuil de rentabilité et l'économie annualisée |
| Tout déployer / replier | Ouvre ou ferme l'arbre complet |
| Exporter CSV | Sort le détail ligne par ligne, ouvrable dans Excel |
| Imprimer | Mise en page papier, sans les contrôles |

Chaque poste porte une étiquette de levier, pour trier ce qui est réellement actionnable :

- **négociable** — renégociable à court terme
- **structurel** — demande une décision d'organisation
- **fixe** — subi, peu compressible
- **volume** — varie avec le carnet de commandes
- **inconnu** — GL pas encore mappé

### Réconciliation

Le montant d'un niveau est toujours la somme exacte du niveau inférieur : de la ligne
« Frais généraux » jusqu'à une facture précise, sans écart. C'est vérifié par test à
chacun des cinq niveaux.

## Routes

| Route | Rôle |
|---|---|
| `GET /api/etat-resultats/vue` | L'écran interactif |
| `GET /api/etat-resultats?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ` | L'état des résultats en JSON, arbre complet |
| `GET /api/etat-resultats/diagnostic` | Ce que le bridge voit : base joignable ou non, fichiers présents, tables mappées |
| `GET /api/etat-resultats/diagnostic-bd` | Introspection de la base : tables et colonnes réelles |

Toutes exigent la clé API (`?key=` ou en-tête `x-api-key`).

## D'où viennent les chiffres

| Donnée | Table Avantage | Rôle |
|---|---|---|
| Revenus | `FACTMA` | Facturation client, dénominateur de tout l'état |
| Charges fournisseurs | `PYBBIL` | Factures avec ventilation GL. **Une facture sans numéro de projet est un frais général** — c'est la seule façon de distinguer une charge de structure d'un coût de chantier |
| Main-d'œuvre et écritures | `TRANS` | Types `E` (salarial) et `B` (bancaire) |
| Noms de projets | `CONTRA` | Libellés et clients |
| Divisions CSI | `ACTIVE`, `COMITE` | Libellés de division, et rattachement commande → division |

Les GL de taxes (`21300`, `21310`, `21340`, `21370`) sont exclus : ce ne sont pas des
charges. Le montant net de chaque facture est reconstruit à partir des paires GL.

L'écran affiche la provenance de chaque jeu de données — `BD`, `CSV` ou `ABSENT` — pour
qu'on sache toujours d'où sort un chiffre.

## Brancher la lecture directe en base

Par défaut le module lit les exports CSV. Pour lire la base :

```bash
npm install odbc
```

Dans `.env` :

```
AVANTAGE_DSN=AVA01
AVANTAGE_BD_ACTIVE=true
```

Puis appeler `GET /api/etat-resultats/diagnostic-bd` : la réponse liste les tables et les
colonnes réellement présentes. Reporter ces noms dans `src/config/colonnes-avantage.js`
et passer `mappe: true` sur chaque table.

`FACTMA` et `CONTRA` sont déjà mappées (leurs noms de colonnes sont connus). `PYBBIL`,
`TRANS`, `ACTIVE` et `COMITE` restent à confirmer : leurs exports sont positionnels, donc
les noms de colonnes en base ne sont pas déductibles. Tant qu'une table n'est pas mappée,
le bridge retombe automatiquement sur son export CSV et le signale.

Pour identifier le moteur installé, lancer sur le PC :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\decouvrir-bd-avantage.ps1
```

Le script n'écrit rien, il inspecte et produit `decouverte-bd-avantage.txt` : pilotes
ODBC, DSN, services de bases de données, extensions et signatures binaires des fichiers
de données.

## Compléter le plan comptable

`src/config/plan-comptable.js` classe les charges en trois passes, de la plus fiable à la
plus approximative :

1. **GL exact** — numéros relevés dans les données réelles
2. **Préfixe de GL** — repli par famille de comptes
3. **Mot-clé de fournisseur** — pour les frais généraux sans GL mappé (Aviva → assurances,
   Mallette → honoraires, RBQ → permis…)

Ce qui échappe aux trois passes tombe dans **« À classer »** et reste visible dans le
rapport, inclus dans le résultat net. Rien n'est perdu en silence. L'écran affiche un
avertissement dès que la part non classée dépasse 2 %, avec la liste des GL à mapper
triée par montant : c'est la liste de travail pour affiner le plan comptable.

## Tests

```bash
npm test
```

25 vérifications : refus d'écriture, classification, exclusion des taxes, réconciliation
du drill-down aux cinq niveaux, exclusion hors période, annualisation.
