# CERVEAU CENTRAL CRC — ARCHITECTURE DE RÉFÉRENCE

**Construction Richard Champagne** — Entrepreneur général
Référence : INBOX-INTEL-ARCH-1.0 · Version : 1.0
Contact : Thierry-Eliot Villeneuve (t.villeneuve@c-rc.ca) · 418-365-7973

---

## 1. PRINCIPE DIRECTEUR

Le cerveau n'est pas un modèle d'IA : c'est la **mémoire structurée** de CRC —
la timeline complète des communications, les notes projet, les décisions des
CP. Les modèles (Ollama local, Claude) sont des moteurs de raisonnement
interchangeables branchés sur cette mémoire. L'investissement durable est dans
la couche de données ; les moteurs se remplacent sans perte.

Trois règles non négociables :

1. **Aucune action ne s'exécute sans décision humaine.** Toute suggestion est
   créée en statut `en_attente` ; seul le CP confirme, modifie ou rejette.
2. **Le CP responsable du projet est notifié en premier.** Le VP opérations
   n'est notifié que sur escalade explicite.
3. **Aucun rattachement silencieux à faible confiance.** Sous le seuil, le
   courriel va en file de validation manuelle.

## 2. VUE D'ENSEMBLE

```
   Microsoft 365 (toutes les boîtes)
        │  Graph API — delta queries (jamais de re-scan)
        │  App « CRC Inbox Intel », permission applicative Mail.Read
        ▼
┌───────────────────────── SERVEUR INTERNE CRC ─────────────────────────┐
│                                                                        │
│  Worker courriels (Node, même machine que le bridge Avantage)          │
│    1. sync delta par boîte · déduplication par Message-ID (RFC 5322)   │
│    2. OLLAMA (modèle local 8-14B)  ◄── ~90 % du volume                 │
│       classification · extraction code projet · résumé court · tri     │
│    3. ROUTAGE (règles §4) ──► CLAUDE  ◄── ~10 % à forte valeur         │
│       réclamations · directives · briefs · synthèses · rédaction       │
│                                                                        │
│  Bridge Avantage v8 (existant) — lit la DB Avantage via ODBC           │
│                                                                        │
│  Écrit dans :                                                          │
│    ├── BASE44 (app Inbox Intel) : EvenementTimeline + ActionSuggeree   │
│    └── VAULT OBSIDIAN (dépôt git local au serveur) : notes Markdown    │
└────────────────────────────────────────────────────────────────────────┘
        │                                    │
        ▼                                    ▼
  Interface Base44                    Obsidian des gestionnaires
  (timeline, validation,              (brief du matin, mémoire projet,
   décisions des CP)                   plugin obsidian-git : pull auto)
```

Claude (sessions et Routines planifiées) lit et écrit le même vault et les
mêmes entités Base44 : c'est lui qui produit le brief quotidien, monte les
dossiers de réclamation (skill `crc-claim-builder`) et rédige les documents
formels (skill `crc-brand`).

## 3. COMPOSANTS

| Composant | Rôle | État |
|---|---|---|
| Bridge Avantage v8 | Données financières depuis la DB Avantage (ODBC) | En place |
| Worker courriels | Sync Graph delta multi-boîtes, déduplication | À construire (§7, phase 2) |
| Ollama (serveur CRC) | Classification, extraction, résumés — les courriels ne quittent jamais CRC | À installer |
| Routage | Aiguillage local/Claude selon règles explicites | À construire avec le worker |
| App Base44 Inbox Intel | Interface opérationnelle des CP | Prompt de construction prêt (`PROMPT-BASE44.md`) |
| Vault Obsidian (git) | Mémoire structurée, briefs, notes projet | À initialiser (§5) |
| Claude (Routines) | Briefs, analyses, réclamations, rédaction | Disponible |

## 4. RÈGLES DE ROUTAGE LOCAL / CLAUDE

Le modèle local traite tout en première passe. Escalade vers Claude quand au
moins une condition est vraie :

| # | Condition | Justification |
|---|---|---|
| R1 | `type_document ∈ {reclamation, directive_chantier}` | Enjeu contractuel — l'analyse fine paie |
| R2 | `confiance_classification < 0,70` (local) | Le local doute → second avis |
| R3 | Montant détecté ≥ 25 000 $ | Seuil de matérialité (ajustable) |
| R4 | Tâche de synthèse : brief quotidien, digest hebdo, dossier de réclamation | Multi-documents, hors de portée d'un 8B |
| R5 | Rédaction d'un document au nom de CRC | Ton et gabarits `crc-brand` |

Tout événement porte un champ `moteur` (`local` ou `claude`) — traçabilité
complète du traitement, visible dans l'interface.

**Réalité des coûts** : à 200-400 courriels/jour, même tout traiter via un
petit modèle Claude coûterait quelques dollars par mois. La justification du
local est la **souveraineté des données** (les courriels restent chez CRC) et
l'indépendance, pas l'économie. Le routage ci-dessus optimise donc la
confidentialité d'abord, la qualité ensuite, le coût en troisième.

## 5. VAULT OBSIDIAN — STRUCTURE

Le serveur héberge le **dossier** (dépôt git « bare » + copie de travail que
le worker committe). Obsidian s'installe sur les postes des gestionnaires,
plugin `obsidian-git` en tirage automatique.

```
CRC-Vault/
├── Projets/
│   └── P26010/
│       ├── _Projet.md          # fiche maîtresse : CP, client, jalons, liens
│       ├── Timeline.md         # journal chronologique (append par le worker)
│       └── Documents/          # 1 note par élément à suivre
│           ├── RFI-006.md      #   frontmatter : type, date, expéditeur,
│           └── Reclamation-gypse.md   # échéance, statut, moteur, source
├── Briefs/
│   └── 2026-07-13 - David.md   # généré chaque matin par Claude (Routine)
├── Personnes/                  # intervenants récurrents (liés par LienEntite)
└── _Systeme/
    ├── routage.md              # les règles §4, versionnées et modifiables
    └── prompts/                # prompts de classification, versionnés
```

Frontmatter type d'une note Document :

```yaml
---
type: reclamation
projet: P24020
date: 2026-07-12
expediteur: Gypse & Finition Rivard
echeance: 2026-07-16
statut: en_attente
moteur: claude
graph_message_id: AAMkAG...
---
```

## 6. PROMPT DE CLASSIFICATION — MODÈLE LOCAL 8B

Un petit modèle exige un prompt plus strict que Claude : sortie JSON forcée
(`format: json` d'Ollama), énumérations fermées, aucun texte libre hors
champs. Prompt de départ (à calibrer sur un échantillon réel avant mise en
service — cible : ≥ 90 % d'accord avec Claude sur 200 courriels) :

```
Tu classifies un courriel reçu par un entrepreneur général en construction
au Québec. Réponds UNIQUEMENT en JSON valide, sans autre texte.

Types permis (choisir exactement un) :
dessin_atelier | facture | rfi | retard | reclamation | directive_chantier | general

Règles :
- "dessin_atelier" : dessins, fiches techniques, échantillons soumis pour approbation
- "facture" : facture, état de compte, demande de paiement
- "rfi" : demande d'information ou de clarification technique
- "retard" : avis de délai, report de livraison, rupture de stock
- "reclamation" : réclamation, coûts additionnels, mise en demeure, avis de litige
- "directive_chantier" : directive, ordre de changement, avenant, instruction
- "general" : tout le reste
- En cas de doute entre deux types, choisis celui de la liste le plus haut.
- code_projet : motif P suivi de 5 chiffres (ex. P26010) ou 5 chiffres commençant par 2.

Schéma de sortie :
{"type_document": "...", "confiance": 0.0, "code_projet": "P00000 ou null",
 "resume": "une phrase factuelle en français", "montant_detecte": 0.0,
 "echeance_detectee": "AAAA-MM-JJ ou null"}

Courriel :
Objet : {{objet}}
De : {{expediteur}}
Corps : {{corps}}
```

L'action suggérée n'est **pas** demandée au modèle local : sous 14B, la
qualité est insuffisante pour ce qui engage le jugement. Elle vient soit de
Claude (cas routés), soit d'un gabarit factuel minimal (« réviser et décider »)
en attendant la décision du CP.

## 7. MATÉRIEL ET DÉPLOIEMENT

**Matériel** : au volume CRC (200-400 courriels/jour), un poste serveur avec
une carte GPU grand public (24 Go VRAM type RTX 4090, ~2 500 $) exécute un
modèle 8-14B avec marge. En dépannage, l'inférence CPU suffit pour la
classification en lot (latence de quelques secondes par courriel, sans
importance en traitement différé).

**Phases** :

| Phase | Contenu | Prérequis |
|---|---|---|
| 1. Fondations | App Base44 (prompt prêt) + vault git initialisé + Ollama installé et calibré sur 200 courriels réels | Serveur CRC |
| 2. Ingestion | Worker Graph delta multi-boîtes + routage + écriture Base44/vault | Consentement admin M365 (§8) |
| 3. Briefs | Routine Claude quotidienne : brief par CP dans le vault + notifications | Phases 1-2 |
| 4. Extensions | Digest hebdo direction, dossiers `crc-claim-builder` auto-amorcés, indicateurs | Rodage |

## 8. SÉCURITÉ

- **Secrets** : secret client Graph et clés Base44 dans le `.env` du serveur
  uniquement — jamais dans git, jamais dans un chat. La clé Base44 exposée
  dans l'historique git de ce dépôt doit être révoquée (voir
  `AUDIT-PREREQUIS.md`).
- **Portée M365** : Application Access Policy Exchange limitant l'app aux
  boîtes du groupe `InboxIntel-Boites` — élargissable, jamais « tout par défaut ».
- **Accès au vault** : dépôt git privé ; mêmes règles d'accès que les dossiers
  projet réseau.
- **Traçabilité** : chaque événement conserve `moteur`, `confiance`,
  `graph_message_id` — tout traitement est auditable.

---

*Construction Richard Champagne inc. · Saint-Tite, Québec · RBQ 8231-1127-01 ·
NEQ 1180040314 · info@c-rc.ca · 418-365-7973*
