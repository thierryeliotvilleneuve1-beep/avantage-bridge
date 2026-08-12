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

## Instantané autonome — un seul fichier à transmettre

L'écran ci-dessus a besoin du bridge en marche. Pour obtenir une version qui s'ouvre
seule — sur un téléphone, chez le comptable, en pièce jointe — produire un instantané :

```bash
npm run instantane                                      # les douze derniers mois
npm run instantane -- 2025-01-01 2025-12-31              # une période précise
npm run instantane -- 2025-01-01 2025-12-31 "Bilan.html" # un nom de fichier choisi
```

Le résultat est **un seul fichier HTML** avec les données incluses : aucun serveur,
aucune connexion. Le drill-down, la recherche et le simulateur fonctionnent tels quels.
Compter environ 900 Ko pour une année complète.

C'est aussi la façon de faire circuler les chiffres sans donner accès à Avantage :
le fichier ne contient que le résultat de la lecture, jamais un identifiant.

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

Deux lignes dans `.env`, et rien à installer :

```
AVANTAGE_DSN=AVA01
AVANTAGE_BD_ACTIVE=true
```

Relancer le bridge, puis appeler une fois :

```
GET /api/etat-resultats/mappage?key=VOTRE_CLE_API
```

### Pourquoi aucune installation

Le module npm `odbc` est une extension native : sous Windows il réclame node-gyp, Python
et les Build Tools de Visual Studio. Le bridge passe donc par **PowerShell et
System.Data.Odbc**, livrés avec Windows.

Ce module ne figure volontairement pas dans les dépendances, même optionnelles : sa
compilation échouerait bruyamment à chaque `npm install` sans rien apporter. Qui veut le
gain de vitesse sur de gros volumes l'installe à la main avec `npm install odbc` — le
bridge le détecte et le préfère alors automatiquement. `AVANTAGE_BD_VOIE` force une voie
si besoin.

Le moteur de base n'a pas à être connu : Actian Zen, SQL Server, Sybase ou autre, c'est le
pilote ODBC installé qui s'en charge. Seul le DSN change.

### Pourquoi rien à transcrire à la main

Les exports d'Avantage sont positionnels : le bridge lit PYBBIL par index de colonne
(33 = numéro de projet, 48 = nom du fournisseur…). Ces index reflètent l'ordre des colonnes
de la table, donc l'index 33 devrait être la 34e colonne. C'est une hypothèse forte, pas une
certitude — alors le bridge la **vérifie** avant de s'en servir :

1. il interroge le pilote pour obtenir les colonnes réelles ;
2. il associe chaque champ par position ;
3. il échantillonne 300 lignes et contrôle que chaque colonne contient bien ce qu'on
   attend — une date ressemble à une date, un numéro de projet est numérique, un montant
   est un nombre, un numéro de GL fait quatre ou cinq chiffres ;
4. le mappage n'est retenu que si **chaque champ obligatoire** passe son contrôle à 85 % ou
   plus sur l'échantillon.

Une table dont la déduction échoue continue d'être lue dans son export CSV, et la route
`/mappage` dit précisément quel champ a échoué et pourquoi. **Le bridge ne produit jamais
de chiffres tirés d'un mappage douteux** — il préfère le CSV et le dit.

`FACTMA` et `CONTRA` n'ont pas besoin de déduction : leurs exports portent des en-têtes,
donc leurs noms de colonnes sont connus.

Si la déduction échoue et qu'il faut mapper à la main, `GET /api/etat-resultats/diagnostic-bd`
liste les tables et colonnes réelles, à reporter dans `src/config/colonnes-avantage.js`.

### Identifier le moteur installé

```powershell
powershell -ExecutionPolicy Bypass -File scripts\decouvrir-bd-avantage.ps1
```

Le script n'écrit rien : il inspecte pilotes ODBC, DSN, services de bases de données,
extensions et signatures binaires des fichiers de données, et produit
`decouverte-bd-avantage.txt`.

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
npm run test:tout
```

64 vérifications en trois harnais :

| Harnais | Nombre | Ce qu'il couvre |
|---|---|---|
| `npm test` | 25 | Refus d'écriture, classification, exclusion des taxes, réconciliation du drill-down aux cinq niveaux, exclusion hors période, annualisation |
| `npm run test:mappage` | 19 | Déduction des colonnes par position, et surtout le **refus** d'un mappage faux : dates qui n'en sont pas, montants non numériques, table trop courte, table vide, introspection en échec |
| `npm run test:vue` | 20 | Dans un vrai navigateur : intégrité de l'arbre, drill-down au clic, réconciliation affichée, simulateur, export CSV, absence d'erreur JavaScript |

Le harnais de vue exige Playwright ; sans lui il se signale comme ignoré au lieu d'échouer.
Le harnais de mappage simule le pilote ODBC : la base Avantage n'est pas joignable depuis
un poste de développement, mais ce qui compte — que la validation rejette un mappage
douteux — se vérifie sans elle.
