# Inbox Intel — Proposition de modèle de données (v0.1)

Module de classification automatique des courriels et de timeline de projet pour
Manoeuvre (Base44, App ID `68927e133cde9f63295dd616`) — CRC (418-365-7973).

> **Statut : PROPOSITION — à valider contre le schéma Base44 réel.**
> L'audit MCP des entités `LienEntite` et `IntelligenceProjet` n'a pas encore pu
> être exécuté (voir `AUDIT-PREREQUIS.md`). Les hypothèses à vérifier sont
> marquées ⚠️.

## Conventions observées dans l'app existante

D'après le code du bridge Avantage (`src/writers/base44-writer.js`, routes sync) :

| Convention | Exemple |
|---|---|
| Noms d'entités en PascalCase français | `Projet`, `FactureClient`, `BonDeCommande` |
| Champs en snake_case français | `code_projet`, `numero_facture`, `solde_ouvert` |
| Identifiant interne | `_id` |
| Horodatage de sync | `sync_avantage_ts` (ISO 8601) |
| Rattachement projet dénormalisé | `code_projet` (string, ex. `P23020` / `23020`) |

Les nouvelles entités suivent ces conventions.

---

## Entité 1 : `EvenementTimeline`

Un enregistrement par courriel (ou document) capté, rattaché à un projet.
C'est la source de vérité de la traçabilité : chaque événement est conservé
même si la personne concernée n'était ni destinataire ni en copie.

| Champ | Type | Description |
|---|---|---|
| `projet_id` | string (ref `Projet._id`) | Rattachement fort au projet |
| `code_projet` | string | Dénormalisé pour recherche/filtre rapide (ex. `P23020`) |
| `type_evenement` | enum | `courriel_entrant`, `courriel_sortant` (extensible : `document`, `appel`, `note`) |
| `type_document` | enum | `dessin_atelier`, `facture`, `rfi`, `retard`, `reclamation`, `directive_chantier`, `general` |
| `date_evenement` | datetime ISO | Date/heure du courriel (pas de l'ingestion) |
| `expediteur_email` | string | |
| `expediteur_nom` | string | |
| `destinataires` | array<string> | Adresses « À » |
| `cc` | array<string> | Adresses en copie |
| `objet` | string | Objet du courriel |
| `resume_court` | string | Résumé 1–2 phrases généré par l'IA |
| `pieces_jointes` | array<{nom, type_mime, taille}> | Métadonnées seulement au MVP ; liens SharePoint plus tard |
| `boite_source` | string | Boîte M365 d'où provient le courriel (sync multi-boîtes) |
| `graph_message_id` | string | Id Microsoft Graph **dans cette boîte** |
| `internet_message_id` | string | `Message-ID` RFC 5322 — **clé de déduplication globale** quand le même courriel existe dans plusieurs boîtes |
| `graph_conversation_id` | string | Fil de conversation Graph — hérite du rattachement projet du fil |
| `confiance_classification` | number 0–1 | Confiance du classificateur |
| `methode_classification` | enum | `llm`, `heuristique`, `manuel` |
| `confiance_rattachement` | number 0–1 | Confiance du rattachement au projet |
| `signaux_rattachement` | array<string> | Trace des signaux utilisés (ex. `code_dans_objet`, `fil_conversation`, `lien_entite`) |
| `statut` | enum | `nouveau`, `vu`, `traite`, `a_rattacher` (projet ambigu → file manuelle) |
| `valide_par` | string | Email du CP si la classification/le rattachement a été corrigé à la main |
| `lien_entite_id` | string ⚠️ | Ref vers `LienEntite` si on réutilise le mapping existant courriel↔projet — **à confirmer selon le schéma réel de LienEntite** |

**Index / unicité recommandés** : unique sur (`internet_message_id`, `boite_source`) pour
l'idempotence du sync différentiel ; index sur (`code_projet`, `type_document`, `date_evenement`)
pour le filtrage par type à travers l'historique d'un projet.

### Réponses aux cas d'usage cibles

- « Quand la facture X est arrivée ? » → recherche `type_document=facture` + texte sur `objet`/`resume_court`.
- « Tous les dessins d'atelier envoyés » → filtre `code_projet` + `type_document=dessin_atelier` + `type_evenement=courriel_sortant`.
- Personne concernée absente du fil → l'événement existe quand même, rattaché au projet ; la timeline est consultable par n'importe qui ayant accès au projet.

---

## Entité 2 : `ActionSuggeree`

Une suggestion d'action générée à partir du **contenu** du courriel (pas de
workflow figé par type). **Aucune exécution automatique** : le CP confirme,
modifie ou rejette.

| Champ | Type | Description |
|---|---|---|
| `evenement_id` | string (ref `EvenementTimeline._id`) | Événement déclencheur |
| `projet_id` / `code_projet` | string | Dénormalisé comme ci-dessus |
| `description_action` | string | Action proposée par l'IA, en texte libre |
| `justification` | string | Pourquoi cette action (extraits du courriel) |
| `priorite` | enum | `basse`, `normale`, `haute`, `urgente` |
| `echeance_suggeree` | date | Si une date limite est détectée dans le courriel |
| `cp_email` | string ⚠️ | CP responsable du projet, notifié en premier — **dépend d'où vit l'assignation CP↔Projet dans le schéma (champ sur `Projet` ? entité d'équipe ?)** |
| `statut` | enum | `en_attente` → `confirmee` \| `modifiee` \| `rejetee` ; puis `executee` |
| `action_finale` | string | Texte final si le CP a modifié la suggestion |
| `decide_par` | string | Email de la personne qui a tranché |
| `date_decision` | datetime | |
| `escalade` | boolean | `true` seulement sur escalade explicite (alors Carl/VP ops est notifié) |

**Machine d'états** : `en_attente` est le seul état de création possible.
Toute transition vers `executee` exige un passage préalable par `confirmee` ou
`modifiee` — c'est la garantie structurelle du « toujours un humain dans la boucle ».

---

## Intégration avec l'existant

- **`LienEntite`** ⚠️ : si elle mappe déjà contacts/courriels ↔ projets/clients,
  elle devient un **signal de rattachement** (l'expéditeur `x@fournisseur.com`
  est lié au projet P23020 → forte présomption). On ne la remplace pas.
- **`IntelligenceProjet`** ⚠️ : les insights agrégés (ex. « 3 avis de retard du
  même sous-traitant ce mois-ci ») s'écrivent là, pas dans la timeline. La
  timeline reste l'historique brut ; `IntelligenceProjet` reste la couche analyse.
- **RLS** : avant toute création d'entité, auditer les règles RLS des 126 entités
  existantes pour répliquer le modèle d'accès (qui voit quels projets). Les
  événements timeline doivent hériter de la visibilité projet.

## Rattachement au projet (multi-signaux)

Ordre d'évaluation, avec score de confiance cumulé :

1. Code projet explicite dans l'objet ou le corps (`P23020`, `23020`, `#23020`).
2. Fil de conversation (`graph_conversation_id`) déjà rattaché à un projet.
3. Correspondance `LienEntite` sur l'expéditeur/destinataires. ⚠️
4. Indices contextuels (nom du chantier, adresse, nom du client) contre `Projet.nom`.

Sous un seuil de confiance (proposé : 0,6) → `statut = a_rattacher`, file de
validation manuelle. Jamais de rattachement silencieux à faible confiance.

## Sync M365 (pour plus tard — hors périmètre MVP)

- Microsoft Graph **delta queries** par boîte (`/messages/delta`) : sync
  différentiel natif, on persiste le `deltaLink` par boîte.
- Auth **Gravitee OAuth2** (chemin déjà validé — pas l'ancien AppID/session).
- Déduplication inter-boîtes par `internet_message_id`.
