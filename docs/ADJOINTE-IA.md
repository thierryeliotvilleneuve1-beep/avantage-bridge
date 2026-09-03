# Adjointe IA — interface de la boîte projets@c-rc.ca

Module greffé au bridge Avantage (même processus Node, même PC, même PM2).
Interface : `http://localhost:3000/adjointe/`

Gouvernance de référence, dans le vault CRC :
`00-Gouvernance/Mandat-Agent-Adjointe.md`, `00-Gouvernance/RACI.md`,
`00-Gouvernance/Politique-IA-Surveillance.md`,
`00-Gouvernance/Procedure-Alimentation-Courriels.md`.
**Le code ne remplace pas ces notes — il les applique.** Toute règle modifiée dans le vault
doit être reportée dans `src/adjointe/policy.js` et `src/adjointe/triage.js`.

---

## 1. Échelle d'autonomie

| Niveau | Ce que l'Adjointe fait | Ce qu'elle ne fait toujours pas | Risque si erreur |
|---|---|---|---|
| **N0 — Observation** | Lit, trie, propose des réponses visibles dans l'interface seulement | Rien n'est écrit dans Outlook | Nul — aucune trace externe |
| **N1 — Classement** | + applique les catégories Outlook (code de projet, état) | N'écrit aucun texte, ne déplace ni ne supprime | Faible — une catégorie se retire en un clic |
| **N2 — Brouillons** | + dépose le brouillon dans *Brouillons* de la boîte | N'envoie jamais | Faible — un brouillon non envoyé n'a aucun effet |
| **N3 — Envoi restreint** | + envoie seuls les accusés de réception (`document_attendu`, sans pièce jointe, urgence normale, projet non sensible) | Ne répond jamais sur prix, délai, portée, réclamation | Réel — un courriel part au nom de CRC |

Réglage : `ADJOINTE_NIVEAU` dans `.env`. **Départ obligatoire à 0.**

Recommandation : deux semaines à N0, deux semaines à N1, un mois à N2 avec relecture
systématique, et N3 seulement si le journal montre zéro brouillon corrigé sur le fond
pendant tout le mois.

## 2. Garde-fous codés en dur

Indépendants du niveau et du modèle — ils ne peuvent pas être contournés par une consigne
de rédaction :

- **Sujets réservés** — un message touchant le **prix**, le **délai** ou la **portée** est
  escaladé, jamais répondu (RACI : « Toujours — aucune exception »).
- **Catégories bloquées** — directive, ODC, bon de commande, facturation, réclamation.
- **Dossiers sensibles** — `P24020`, `P25007`, `P25019` : aucun brouillon, aucune
  consignation automatique au vault (Procédure §6).
- **Filtre financier** — un brouillon destiné à l'externe portant un montant est refusé à
  l'envoi, même approuvé dans l'interface.
- **Filtre d'engagement** — « nous confirmons », « nous nous engageons », « approuvé » :
  refusé.
- **Caviardage** — tout numéro de téléphone autre que le 418-365-7973 de CRC est retiré des
  brouillons et de ce qui est écrit au vault.
- **Journal en ajout seul** — `data-adjointe/journal.jsonl` : triage, brouillon, envoi,
  rejet, consignation. Aucune ligne n'est réécrite.

## 3. Accès Microsoft Graph — à faire une seule fois

L'accès délégué du connecteur Microsoft 365 permet la **lecture**. Écrire un brouillon ou
envoyer exige une inscription d'application. Étapes, dans le portail Entra ID du locataire
CRC :

1. **Inscrire l'application** — Entra ID → Inscriptions d'applications → Nouvelle.
   Nom : `CRC — Adjointe IA (projets)`. Comptes du locataire uniquement. Aucun URI de redirection.
2. **Permissions d'API** — Microsoft Graph → **Permissions d'application** :
   `Mail.ReadWrite` et `Mail.Send`. Puis **Accorder le consentement administrateur**.
   Ne pas ajouter `Mail.Read` déléguée, ni aucune permission de calendrier ou de fichiers.
3. **Secret client** — Certificats et secrets → Nouveau secret client, échéance 12 mois.
   Noter la valeur : elle ne se réaffiche pas. Inscrire l'échéance au calendrier.
4. **Restreindre la portée à la seule boîte projets** — sans cette étape, l'application lit
   *toutes* les boîtes du locataire. Dans PowerShell Exchange Online :

   ```powershell
   Connect-ExchangeOnline
   New-DistributionGroup -Name "SG-Adjointe-IA-Portee" -Type Security `
     -Members "projets@c-rc.ca"
   New-ApplicationAccessPolicy -AppId "<GRAPH_CLIENT_ID>" `
     -PolicyScopeGroupId "SG-Adjointe-IA-Portee" -AccessRight RestrictAccess `
     -Description "Adjointe IA — projets@c-rc.ca uniquement"
   # Vérification obligatoire :
   Test-ApplicationAccessPolicy -Identity projets@c-rc.ca -AppId "<GRAPH_CLIENT_ID>"  # Granted
   Test-ApplicationAccessPolicy -Identity t.villeneuve@c-rc.ca -AppId "<GRAPH_CLIENT_ID>"  # Denied
   ```

   La propagation prend jusqu'à 30 minutes. **Ne pas mettre le bridge en service avant que le
   second test retourne `Denied`.**
5. **Renseigner `.env`** — `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
   `ANTHROPIC_API_KEY`, puis `pm2 restart avantage-bridge`.
6. **Vérifier** — ouvrir `/adjointe/` : le bandeau doit afficher « Accès confirmé à
   projets@c-rc.ca ».

## 4. Exploitation

| Action | Où |
|---|---|
| Balayage manuel | Bouton « Lancer un cycle de triage » |
| Balayage automatique | `ADJOINTE_CRON` (ex. `*/30 6-18 * * 1-5`) — vide = désactivé |
| Préparer une réponse | Carte → « Préparer un brouillon » |
| Envoyer | Carte → relire le texte → « Approuver et envoyer » (confirmation exigée) |
| Consigner au vault | Carte → « Consigner au vault » (`VAULT_DIR` requis) |
| Piste d'audit | Table « Journal d'audit » + `data-adjointe/journal.jsonl` |

Fenêtre de balayage : depuis la dernière exécution, jamais plus de 14 jours en arrière.
Les accusés de lecture, notifications de plateforme, confirmations de commande et transferts
« PTI » vides sont écartés d'office (Procédure §3 et annexes).

## 5. API

Toutes les routes exigent l'en-tête `x-api-key` (même clé que le reste du bridge).
Les identifiants de message circulent dans le corps de la requête, jamais dans le chemin.

| Méthode | Route | Effet |
|---|---|---|
| GET | `/api/adjointe/statut` | Niveau, accès Graph, compteurs |
| GET | `/api/adjointe/file` | File de traitement (`?statut=`, `?projet=`, `?categorie=`) |
| GET | `/api/adjointe/journal` | Journal d'audit |
| POST | `/api/adjointe/cycle` | Balayage `{niveau?, limite?, depuis?}` |
| POST | `/api/adjointe/brouillon` | `{id, notes?}` — rédige une proposition |
| POST | `/api/adjointe/envoyer` | `{id, corps?, approuve_par}` — **action humaine** |
| POST | `/api/adjointe/rejeter` | `{id, motif?}` |
| POST | `/api/adjointe/traite` | `{id}` |
| POST | `/api/adjointe/vault` | `{id}` — consigne au journal du vault |

## 6. Points ouverts avant la mise en service

- [ ] `Politique-IA-Surveillance.md` est au statut **PROJET**. L'ingestion de
      `projets@c-rc.ca` est déjà autorisée ; l'**envoi** automatique au nom de CRC (N3) ne
      l'est pas — décision de direction à consigner dans `Journal-Decisions.md`.
- [ ] Informer les utilisatrices de la boîte que des brouillons y apparaîtront.
- [ ] Ligne de signature à valider : le guide de marque porte le 418 365-7788, la directive
      organisationnelle le 418-365-7973 (retenu ici pour la coordination de projets).
- [ ] Échéance du secret client à inscrire au calendrier.
