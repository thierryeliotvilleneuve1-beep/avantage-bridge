# Prompt de construction Base44 — App « Inbox Intel CRC » (autonome)

Prompt à coller dans Base44 pour bâtir Inbox Intel comme application séparée
(pas dans Manoeuvre). Les codes projet restent au format CRC (`P23020`) pour
permettre un pont avec Manoeuvre/Avantage plus tard.

---

## PROMPT (copier à partir d'ici)

Construis une application interne en français pour Construction Richard
Champagne (CRC), entrepreneur général au Québec, nommée **Inbox Intel**.

But : classifier automatiquement les courriels de l'entreprise, les rattacher
au bon projet de construction, bâtir une timeline chronologique complète par
projet, et proposer au chef de projet (CP) une action suggérée qu'il doit
confirmer, modifier ou rejeter — **aucune action ne s'exécute jamais
automatiquement**.

### ENTITÉS

**Projet**
- code_projet (texte, unique, format P + 5 chiffres, ex. P23020)
- nom (texte)
- client (texte)
- cp_email (email — chef de projet responsable, destinataire des notifications)
- cp_nom (texte)
- vp_ops_email (email — utilisé SEULEMENT en cas d'escalade explicite)
- statut (choix : actif, termine, suspendu)

**ContactProjet** (annuaire de rattachement : qui est lié à quel projet)
- email (email)
- nom (texte)
- entreprise (texte)
- codes_projets (liste de textes — codes des projets auxquels ce contact est lié)
- role (choix : sous_traitant, professionnel, client, fournisseur, interne, autre)

**EvenementTimeline** (un enregistrement par courriel capté — cœur de l'app)
- code_projet (texte, peut être vide si non rattaché)
- type_evenement (choix : courriel_entrant, courriel_sortant)
- type_document (choix : dessin_atelier, facture, rfi, retard, reclamation, directive_chantier, general)
- date_evenement (date et heure — la date du courriel, pas de la saisie)
- expediteur_email (email), expediteur_nom (texte)
- destinataires (liste de textes), cc (liste de textes)
- objet (texte)
- corps (texte long — contenu intégral du courriel)
- resume_court (texte — résumé IA en 1-2 phrases)
- pieces_jointes (liste de textes — noms de fichiers)
- boite_source (texte — boîte courriel d'origine)
- internet_message_id (texte — identifiant unique du courriel ; refuser les
  doublons internet_message_id + boite_source)
- confiance_classification (nombre 0 à 1)
- confiance_rattachement (nombre 0 à 1)
- signaux_rattachement (liste de textes)
- statut (choix : nouveau, vu, traite, a_rattacher)
- valide_par (email — rempli si un humain corrige la classification ou le rattachement)

**ActionSuggeree**
- evenement_id (référence vers EvenementTimeline)
- code_projet (texte)
- description_action (texte long — l'action proposée par l'IA)
- justification (texte long — pourquoi, en citant le courriel)
- priorite (choix : basse, normale, haute, urgente)
- echeance_suggeree (date, optionnelle)
- cp_email (email — le CP notifié)
- statut (choix : en_attente, confirmee, modifiee, rejetee, executee)
- action_finale (texte long — version modifiée par le CP le cas échéant)
- decide_par (email), date_decision (date et heure)
- escalade (booléen, défaut faux)

RÈGLE STRICTE : une ActionSuggeree est toujours créée avec statut
`en_attente`. Le statut `executee` ne peut être atteint que depuis
`confirmee` ou `modifiee`. Jamais de passage direct `en_attente` → `executee`.

### PAGE 1 — Ingestion d'un courriel (MVP : saisie manuelle / collage)

Formulaire : expéditeur (email + nom), destinataires, cc, date/heure, objet,
corps (zone de texte large), boîte source, pièces jointes (noms), case
« courriel sortant ».

Au bouton « Analyser », appelle l'IA (InvokeLLM) avec ce prompt et le contenu
du courriel, en exigeant une réponse JSON :

« Tu analyses un courriel reçu par CRC (Construction Richard Champagne),
entrepreneur général au Québec, pour le rattacher à la timeline d'un projet.
Réponds UNIQUEMENT avec un objet JSON :
{
  "type_document": "dessin_atelier" | "facture" | "rfi" | "retard" | "reclamation" | "directive_chantier" | "general",
  "confiance": nombre entre 0 et 1,
  "resume_court": "résumé factuel en 1-2 phrases, en français",
  "code_projet_detecte": "code projet si mentionné (ex. P23020), sinon null",
  "action_suggeree": "action concrète que le chef de projet devrait considérer, déduite du CONTENU réel du courriel (pas un gabarit par type de document)",
  "justification": "pourquoi cette action, en citant le courriel",
  "priorite": "basse" | "normale" | "haute" | "urgente",
  "echeance_suggeree": "date ISO si une échéance est mentionnée, sinon null"
} »

La classification se fait par le CONTENU (objet + corps), jamais par des
règles rigides sur l'expéditeur.

Rattachement au projet, dans cet ordre (multi-signaux) :
1. code_projet_detecte par l'IA ou trouvé dans objet/corps → confiance 0,85
2. expéditeur trouvé dans ContactProjet avec un seul projet lié → confiance 0,55
3. nom d'un Projet présent dans le texte → confiance 0,5

Si la confiance finale est sous 0,6 ou qu'aucun projet ne correspond :
statut de l'événement = `a_rattacher` (file de validation manuelle). Ne
jamais rattacher silencieusement à faible confiance.

Après analyse, montrer un écran de prévisualisation (type détecté, confiance,
projet proposé, résumé, action suggérée) puis créer l'EvenementTimeline et
l'ActionSuggeree (statut en_attente). Notifier le CP du projet (cp_email du
Projet). Ne JAMAIS notifier le VP ops sauf si le champ escalade est coché
manuellement plus tard.

### PAGE 2 — Timeline de projet

Sélecteur de projet, puis fil chronologique (plus récent en haut) des
EvenementTimeline du projet :
- pastille de couleur par type_document, badge entrant/sortant, date/heure
- objet, expéditeur → destinataires, résumé court
- indicateurs de confiance et signaux de rattachement
- filtres : par type_document (pastilles cliquables avec compteur), par
  entrant/sortant, et recherche plein texte sur objet + résumé + corps
Objectif : n'importe qui peut retrouver « quand la facture X est arrivée » ou
« tous les dessins d'atelier envoyés » en quelques secondes.

### PAGE 3 — File de validation

Deux onglets :
1. **À rattacher** : événements statut `a_rattacher` — l'utilisateur choisit
   le projet dans une liste, l'événement passe à `nouveau` et valide_par est
   rempli. Option « hors projet » pour les courriels non pertinents.
2. **Actions en attente** : ActionSuggeree statut `en_attente`, groupées par
   projet, tri par priorité. Trois boutons par action : Confirmer / Modifier
   (ouvre l'édition du texte, sauvegarde dans action_finale) / Rejeter.
   Enregistrer decide_par et date_decision.

### PAGE 4 — Tableau de bord

Compteurs : courriels traités (7 derniers jours), événements à rattacher,
actions en attente par CP, répartition par type_document (graphique simple).
Liste des 10 derniers événements.

### DESIGN ET RÈGLES

- Interface entièrement en français (Québec).
- Sobre, professionnel, adapté à la construction. Pied de page sur toutes
  les pages : « Construction Richard Champagne — 418-365-7973 ».
- Accès : les CP voient les projets où ils sont cp_email ; un rôle admin voit
  tout. Configurer les règles de sécurité des entités en conséquence.
- Prévoir (sans le construire maintenant) qu'une intégration Microsoft 365
  alimentera plus tard l'ingestion automatiquement : la page d'ingestion
  manuelle doit passer par la même logique d'analyse réutilisable.

Crée aussi 2 projets d'exemple (P23020 « Centre communautaire Ste-Anne »,
P24011 « Caserne 12 Shawinigan ») et 2 contacts d'exemple pour pouvoir tester
immédiatement.

## FIN DU PROMPT

---

## Notes d'implantation (pour nous, pas pour Base44)

- Les 6 courriels test du dépôt (`src/inbox-intel/samples/courriels-test.json`)
  servent de jeu de validation : les coller un par un dans la page d'ingestion
  et comparer aux résultats attendus du prototype (types, rattachements,
  statuts a_rattacher pour T3/T4/T6 sans contact configuré).
- Le pont avec Manoeuvre (sync des projets réels) et le sync M365
  (Graph delta + Gravitee OAuth2) viennent après validation du moteur.
- L'app étant séparée, l'audit RLS des 126 entités de Manoeuvre n'est plus
  bloquant pour le MVP — il redevient nécessaire seulement au moment du pont.
