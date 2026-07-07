# Inbox Intel — Audit Base44 : prérequis et état

## État de l'accès (2026-07-07)

L'audit du schéma Base44 (étape 1 demandée) est **bloqué** dans cet
environnement, pour deux raisons indépendantes :

1. **Connecteur MCP Base44** : installé au niveau de l'organisation claude.ai,
   mais **désactivé pour cette session** (`enabledInChat: false`).
   → À activer dans les paramètres de connecteurs de la conversation.
2. **Politique réseau de l'environnement** : les appels directs vers
   `app.base44.com` sont refusés par le proxy (403 CONNECT). L'API REST
   utilisée par le bridge Avantage n'est donc pas joignable non plus.
   → Alternative : ajouter `app.base44.com` à la liste d'autorisation réseau
   de l'environnement Claude Code.

L'un **ou** l'autre débloque l'audit. Le connecteur MCP est le chemin préféré
(schéma complet + RLS visibles), l'API REST ne montre que les données.

## Checklist d'audit à exécuter dès que l'accès est ouvert

- [ ] Dump du schéma de `LienEntite` : champs exacts, comment les courriels y
      sont référencés aujourd'hui (id Graph ? adresse ? URL ?), cardinalités.
- [ ] Dump du schéma de `IntelligenceProjet` : format des insights, qui écrit
      dedans actuellement.
- [ ] Recherche parmi les 126 entités de toute table déjà liée aux courriels
      (mots-clés : courriel, email, message, communication, inbox).
- [ ] Où vit l'assignation **CP ↔ Projet** (champ sur `Projet` ? entité
      d'équipe/rôle ?) — nécessaire pour la notification du bon CP.
- [ ] Audit RLS : règles d'accès des entités projet existantes, à répliquer
      sur `EvenementTimeline` et `ActionSuggeree` avant création.
- [ ] Vérifier s'il existe déjà des enums/vocabulaires de types de documents.
- [ ] Confirmer le mécanisme de notification disponible dans Base44
      (notification in-app ? courriel sortant ? webhook ?).

## ⚠️ Sécurité — à corriger indépendamment

Le fichier `.env.example` du dépôt contient une **clé API Base44 réelle**
(`BASE44_API_KEY=de56...`) committée dans l'historique git. Cette clé donne
accès en écriture à l'app de production.

- [ ] Révoquer/rotater cette clé dans Base44.
- [ ] Remplacer la valeur dans `.env.example` par un placeholder.
- [ ] La clé restera dans l'historique git : considérer l'historique comme
      compromis tant que la rotation n'est pas faite.
