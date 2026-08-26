# Système comptable CRC — architecture

**Décision prise le 26 août 2026 par Thierry-Eliot Villeneuve :** CRC remplace
Avantage. Le nouveau système devient le **livre officiel** — grand livre en
partie double, fermeture d'exercice, états financiers, TPS/TVQ, T5018. La
liaison bancaire se fait par **Plaid Link**. La paie reste chez **Employeur D**
(Desjardins) : on importe le rapport de paie et on ventile par projet, on ne
réécrit pas la paie CCQ.

---

## 1. Où vivent les livres, et pourquoi pas dans Manœuvre

Manœuvre (Base44) porte déjà 136 entités, dont des coquilles comptables
(`CompteComptable`, `EcritureComptable`, `LigneEcriture`). Le réflexe serait d'y
bâtir la comptabilité. **Les livres officiels vont plutôt dans PostgreSQL.**

Trois raisons, toutes de nature comptable et non de préférence technique :

| Exigence des livres officiels | Ce que l'API d'entités de Base44 offre |
|---|---|
| Une écriture s'enregistre en entier ou pas du tout | Pas de transaction : l'en-tête peut être créé et une ligne échouer, laissant un déséquilibre permanent |
| Débit = crédit, garanti, toujours | Aucune contrainte multi-lignes possible |
| Une écriture validée est immuable | Tout champ reste modifiable par n'importe quel appel `PUT` |
| Numérotation séquentielle sans trou | Aucun mécanisme de séquence |
| Rétention vérifiable sur 7 ans | Dépendance à un fournisseur de plateforme |

Le pont Avantage en donne la démonstration involontaire : `?limit=500` tronquait
silencieusement les listes, le cron remettait à zéro des champs saisis à la main,
et la clé de déduplication écrasait des transactions. Aucun de ces trois bugs
n'est possible dans le schéma `gl` — la base les refuse.

**Répartition retenue :**

```
┌─────────────────────────────────────────────────────────────────┐
│  Manœuvre (Base44)                                              │
│  Projets · BC · soumissions · heures · chantier · documents     │
│  → reste l'outil du quotidien, inchangé                         │
└────────────────────────┬────────────────────────────────────────┘
                         │ événements (facture, BC, heures)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Service comptable (Node) — ce dépôt, dossier comptabilite/     │
│  Moteur d'écritures · règles bancaires · rapports · secrets     │
└────────────────────────┬────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
┌───────────────────────┐   ┌───────────────────────────┐
│  PostgreSQL           │   │  Plaid                    │
│  schéma gl  — livres  │   │  Link · transactions/sync │
│  schéma banque — flux │   │                           │
└───────────────────────┘   └───────────────────────────┘
```

Manœuvre continue d'afficher le contrôle budgétaire ; il le lira désormais de
`gl.cout_projet`, où l'imputation analytique est portée par la ligne d'écriture
elle-même — donc exacte par construction, au lieu d'être reconstituée depuis
`TRANS`, `PYBBIL` et `COMITE`.

---

## 2. Les règles vivent dans la base, pas dans le code

C'est le choix structurant. Cinq règles sont posées comme triggers PostgreSQL
et ne peuvent être contournées ni par un bug applicatif, ni par un script
d'appoint, ni par une connexion `psql` directe :

| # | Règle | Fichier |
|---|---|---|
| 1 | Une écriture validée est équilibrée (contrôle différé au COMMIT) | `002_regles.sql` |
| 2 | Une écriture validée est immuable — on contrepasse, on ne corrige pas | `002_regles.sql` |
| 3 | Rien ne se passe dans une période ou un exercice fermé | `002_regles.sql` |
| 4 | Un compte de regroupement ne reçoit pas d'écriture | `002_regles.sql` |
| 5 | Une période ne se ferme pas sur un brouillon oublié | `002_regles.sql` |

Le contrôle d'équilibre est **différé** : une écriture se construit ligne par
ligne et serait forcément déséquilibrée après la première. Le trigger laisse
construire, puis refuse la transaction entière au COMMIT si les totaux ne
concordent pas. D'où le flux imposé par le moteur : *en-tête en brouillon →
lignes → validation*.

Chacune de ces règles a son test qui prouve qu'elle rejette bien ce qu'elle doit
rejeter. `npm test` — 30 tests, exécutés contre un vrai PostgreSQL embarqué
(PGlite), donc contre le schéma réel et non une imitation.

---

## 3. Ce qui est construit

| Élément | État |
|---|---|
| Exercices et périodes (12 mois + période 13 de clôture) | ✅ testé |
| Plan comptable hiérarchique, comptes de regroupement, marquage des comptes de taxe | ✅ testé |
| Journaux (VTE, ACH, PAI, BQ, CAI, OD, CLO) avec séquence propre à chacun | ✅ testé |
| Passation d'écritures, équilibre garanti | ✅ testé |
| Immutabilité et contrepassation | ✅ testé |
| Idempotence par `source_id` — une facture ne se passe qu'une fois | ✅ testé |
| Balance de vérification, contrôle d'équilibre global | ✅ testé |
| Coût par projet et activité, directement du grand livre | ✅ testé |
| Assiette TPS/TVQ | ✅ testé |
| Ingestion bancaire, zone de transit, règles de catégorisation | ✅ testé |
| Rapprochement bancaire → écriture, sens débit/crédit | ✅ testé |
| Client Plaid (Link, échange de jeton, `transactions/sync` à curseur) | ⚠️ écrit, **jamais exécuté contre l'API Plaid** |

**Automatisation bancaire — deux niveaux, volontairement distincts.** Une règle
*suggère* par défaut et attend une confirmation humaine. Une règle explicitement
marquée `automatique` passe l'écriture seule. Le second n'est jamais le défaut :
ces livres sont opposables, quelqu'un doit avoir décidé qu'une machine a le droit
d'y écrire sans relecture.

---

## 4. Ce qui reste à construire

| Bloc | Dépend de |
|---|---|
| Comptes fournisseurs — facture, approbation, paiement, retenue | socle ✅ |
| Comptes clients — facturation progressive, retenue de garantie | socle ✅ |
| Import du rapport de paie **Employeur D** et ventilation par projet | socle ✅ |
| États financiers — bilan, résultats, résultats par projet | socle ✅ |
| Fermeture d'exercice et report des soldes | périodes ✅ |
| Déclarations TPS/TVQ | `gl.assiette_taxes` ✅ |
| **T5018** — paiements aux sous-traitants | `ligne_ecriture.tiers_*` ✅ |
| Immobilisations et amortissement | socle ✅ |
| Écrans Manœuvre pour la saisie et la révision | API du service |
| Migration des données historiques d'Avantage | plan comptable réel |

---

## 5. Les deux préalables bloquants

Rien ne se met en service avant ces deux points. Ils ne sont pas techniques.

**1. Le plan comptable réel de CRC.** `004_amorce.sql` ne contient que les cinq
comptes que la rétro-ingénierie a permis d'identifier (21300, 21310, 21340,
21370, 33200) plus une dizaine de comptes de contrepartie inventés pour faire
tourner les tests. Le plan comptable complet doit sortir d'Avantage et être
importé. **Tout ce qui est bâti dessus est provisoire jusque-là.**

**2. Trois exercices clos pour validation.** Le seul test qui compte vraiment :
rejouer trois exercices déjà fermés dans Avantage et retrouver, au cent près,
les états financiers que le comptable externe a signés. Sans cet exercice, la
bascule n'est pas vérifiable — et un livre officiel qui ne se vérifie pas ne
vaut rien.

Le comptable externe de CRC devrait être associé dès maintenant, pas à la
livraison : c'est lui qui dira si le plan comptable, les journaux et la
présentation des états répondent à ses besoins.

---

## 6. Sécurité

| Élément | Traitement |
|---|---|
| Jetons d'accès Plaid | Table `banque.plaid_item` isolée, `REVOKE ALL ... FROM PUBLIC`. Ne quittent jamais le serveur, ne sont jamais renvoyés par une API |
| Erreurs Plaid | Le corps brut de la réponse n'est jamais relayé — il peut contenir des identifiants |
| Piste d'audit | `cree_par`, `cree_le`, `valide_par`, `valide_le` sur chaque écriture ; `source_type` et `source_id` tracent l'origine |
| Réauthentification bancaire | `ITEM_LOGIN_REQUIRED` lève `besoin_reauth` au lieu d'échouer en silence |

⚠️ **Dette de sécurité héritée à régler.** La clé API Base44
(`de56105e236d42d29d2f2c75e84fb9ad`) est en clair dans `.env.example`,
`check-extras.js`, `purge-budget.js`, `sync-*.js` et `verify-p23020.js`, tous
commités dans l'historique Git. La clé API du pont est restée à sa valeur par
défaut, `CHANGE_MOI_CLE_SECRETE_LONGUE`. **Ces deux clés doivent être
révoquées et remplacées**, indépendamment de ce projet.
