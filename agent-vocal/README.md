# Standard 24 — réceptionniste IA pour PME québécoises

Plateforme multi-clients : chaque PME cliente possède sa propre fiche de
configuration, son numéro et son agent. Le moteur répond au téléphone en
français, comprend la demande, consulte la fiche de l'entreprise, puis agit —
message, transfert, rendez-vous, escalade d'urgence.

Construction Richard Champagne est le premier client, configuré dans
`data/clients/crc.json` et utilisable comme démonstration.

---

## Ce que fait l'agent

| Capacité | Détail |
|---|---|
| Répondre 24/7 | Décroche à la première sonnerie, en français québécois |
| Répondre aux questions | Uniquement à partir de la fiche du client — jamais d'invention |
| Prendre un message | Nom, rappel, objet, contenu, niveau d'urgence, destinataire |
| Transférer en direct | Vers la bonne personne, selon des mots-clés, pendant les heures d'ouverture |
| Fixer un rendez-vous | Vérifie les plages réellement libres avant de proposer |
| Escalader une urgence | Vers la ligne de garde, à toute heure |
| Filtrer la sollicitation | Remercie et raccroche, sans déranger l'équipe |
| Se faire interrompre | L'appelant peut couper la parole à l'agent (barge-in) |

Chaque appel est consigné : transcription horodatée, résumé, dénouement,
durée. Tout est visible dans la console.

---

## Architecture

```
Appelant
   │  RTC
   ▼
Telus Business Connect  ──(renvoi d'appel)──►  Numéro Twilio
                                                   │  Media Streams (μ-law 8 kHz)
                                                   ▼
                                          ┌──────────────────┐
                                          │  Standard 24     │
                                          │                  │
   Deepgram  ◄──── audio appelant ────────┤  session.js      │
   (fr-CA)   ────► transcription ─────────►                  │
                                          │                  │
   Claude    ◄──── tour de parole ────────┤  cerveau.js      │
   Opus 5    ────► texte + outils ────────►  outils.js       │
                                          │                  │
   ElevenLabs ◄─── phrase à dire ─────────┤                  │
   (fr)       ───► audio μ-law ───────────►  vers la ligne   │
                                          └──────────────────┘
                                                   │
                                          SQLite + console web
```

Le format audio est μ-law 8 kHz **de bout en bout** : la téléphonie, Deepgram
et ElevenLabs parlent tous ce format, donc aucun rééchantillonnage n'est fait
dans le chemin critique. C'est ce qui garde la latence basse.

**Pourquoi Twilio alors que le client est sur Telus Business Connect ?** Telus
Business Connect (RingCentral en marque blanche) ne donne pas accès au flux
audio brut sur les forfaits PME. Le numéro Twilio sert de porte d'entrée
audio ; le numéro d'affaires du client ne change pas et reste chez Telus.
Le module `telephonie/telus-business-connect.js` s'occupe du reste : textos de
suivi depuis le vrai numéro, lecture du journal d'appels, pose de la règle de
renvoi par API.

---

## Mise en service

### 1. Prérequis

| Service | Rôle | Où obtenir la clé |
|---|---|---|
| Anthropic | Compréhension et décision | `console.anthropic.com` |
| Deepgram | Reconnaissance vocale fr-CA | `console.deepgram.com` |
| ElevenLabs | Synthèse vocale française | `elevenlabs.io` |
| Twilio | Porte d'entrée audio + numéro 418/514/450/438 | `console.twilio.com` |
| Telus Business Connect | Textos, journal, renvoi (facultatif) | Portail administrateur TBC |

Node.js 20 ou plus, et un serveur joignable en HTTPS depuis Internet.

### 2. Installation

```bash
cd agent-vocal
npm install
cp .env.example .env      # puis remplir
npm test                  # logique métier — aucune clé requise
npm run verif             # valide la configuration et les fiches clients
npm start
```

`npm run verif` doit afficher **0 échec** avant toute mise en service. Il
vérifie les clés, les numéros en double, les plages horaires incohérentes,
les destinataires de transfert injoignables et les fiches sans voix.

---

## Essayer l'agent

Trois niveaux, du moins coûteux au plus complet.

### Niveau 1 — la logique métier, sans aucune clé

```bash
npm test
```

34 tests : heures d'ouverture aux bornes exactes, changement d'heure,
disponibilités de rendez-vous, acheminement par mots-clés, refus de transfert
hors des heures, escalade d'urgence la nuit, et refus de la FAQ de répondre
hors sujet. C'est ce qui attrape les régressions quand vous modifiez une fiche.

### Niveau 2 — converser avec l'agent par écrit

Seule `ANTHROPIC_API_KEY` est requise. Ni téléphonie, ni synthèse vocale.
Environ un cent par conversation.

```bash
npm run essai crc
npm run essai crc -- --heure "2026-08-18 21:00"   # un mardi soir, entreprise fermée
npm run essai crc -- --heure "2026-12-25 10:00"   # un jour férié
npm run essai crc -- --appelant +15145551234
```

`--heure` s'interprète dans le fuseau du client : « 21:00 » veut dire 21 h
chez lui, peu importe où tourne le serveur.

La console affiche chaque outil appelé, ce qu'il a répondu et l'action qui en
découle, ce qui rend les décisions de l'agent lisibles :

```
Appelant ▸ j'appelle pour le chantier de l'école, il y a de l'eau au sous-sol

  ▸ escalader_urgence(nature: "dégât d'eau", lieu: "chantier de l'école")
    └─ Urgence enregistree. Transfert vers la ligne d'urgence en cours.
  ⚑ ACTION transfert {"numero":"+14183657973","vers":"ligne urgence"}
```

L'appel est consigné en base : il apparaît dans la console web avec sa
transcription, comme un vrai appel.

**Ce qu'il vaut la peine d'essayer :** poser une question absente de la FAQ
(il doit prendre un message, pas inventer), demander un prix de soumission
(il doit refuser), se faire passer pour un vendeur de logiciel (il doit
raccrocher), appeler à 21 h en demandant Carl (il doit prendre un message,
pas transférer), et déclarer une urgence la nuit (il doit escalader).

### Niveau 3 — un vrai appel téléphonique

Exige les cinq clés, un numéro Twilio et un serveur joignable en HTTPS. En
développement, `ngrok http 8080` donne l'URL publique à mettre dans
`URL_PUBLIQUE` et dans le webhook Twilio. C'est le seul niveau qui éprouve la
latence, la qualité de la voix et le barge-in.

### 3. Configuration Twilio

1. Acheter un numéro local (indicatif 418, 514, 450 ou 438).
2. Dans la configuration du numéro, section **Voice** :
   - *A call comes in* → **Webhook**
   - URL : `https://votre-domaine.ca/twilio/voix`
   - Méthode : **HTTP POST**
3. Reporter ce numéro dans la fiche du client, champ `numero_agent`.

> `TWILIO_AUTH_TOKEN` doit être défini : sans lui, l'endpoint `/twilio/voix`
> accepte n'importe quelle requête. Le serveur le signale au démarrage.

### 4. Branchement de Telus Business Connect

C'est l'étape qui met l'agent en service sans toucher au numéro d'affaires.

**Par l'interface web** — Portail administrateur → *Utilisateurs* →
l'extension visée → *Gestion des appels* → *Règles de réponse* →
**Ajouter une règle** :

| Scénario | Réglage |
|---|---|
| L'agent prend tout | Règle *Toujours*, action **Transférer les appels**, destination = numéro Twilio |
| L'agent prend le débordement | Règle *Heures d'ouverture*, sonner l'équipe 3 fois, puis renvoyer au numéro Twilio |
| L'agent prend le soir et la fin de semaine | Règle *Après les heures*, action **Transférer les appels**, destination = numéro Twilio |

Le dernier scénario est le plus courant au démarrage : l'équipe garde ses
appels de jour, l'agent couvre les soirs, les nuits et les fins de semaine.

**Par API** — pour poser la règle sans passer par l'interface :

```js
const { tbc } = require('./src/telephonie/telus-business-connect');

await tbc.creerRenvoiVersAgent('+14185550142', {
  nom: 'Agent vocal Standard 24',
  toujours: false,   // false = heures d'ouverture, true = en tout temps
});

console.log(await tbc.reglesReponse());   // vérifier la règle posée
```

L'authentification utilise un JWT d'application (`TBC_JWT`), à créer dans le
portail développeur RingCentral associé au compte Telus Business Connect, avec
les permissions `ReadAccounts`, `EditExtensions`, `SMS` et `ReadCallLog`.

### 5. Voix

Choisir une voix française dans ElevenLabs, copier son identifiant, puis le
mettre soit dans `VOIX_DEFAUT` (pour tous les clients), soit dans `voix_id`
de la fiche du client. Les voix québécoises ou françaises neutres à débit
posé donnent les meilleurs résultats au téléphone.

---

## Ajouter un client

Créer `data/clients/<identifiant>.json`. Prendre `crc.json` comme modèle.

| Champ | Obligatoire | Rôle |
|---|---|---|
| `nom` | oui | Nom que l'agent prononce |
| `persona.nom_agent` | oui | Prénom de l'agent |
| `persona.presentation` | non | Phrase d'accueil exacte |
| `heures` | oui | `{"lun":["07:00","16:30"], "sam":null, …}` |
| `numero_agent` | oui | Numéro Twilio, format E.164 |
| `numero_transfert_defaut` | recommandé | Repli si aucun destinataire ne correspond |
| `equipe[]` | non | `nom`, `role`, `telephone`, `courriel`, `mots_cles` |
| `faq[]` | recommandé | `{q, r}` — la seule source de réponses factuelles |
| `services[]` | non | Ce que l'entreprise offre |
| `urgences` | non | `mots_cles`, `numero` — active l'escalade |
| `rdv` | non | `actif`, `duree_min`, `plages` — active la prise de rendez-vous |
| `exclusions[]` | non | Types de sollicitation à filtrer |
| `consignes` | non | Règles particulières injectées dans le prompt |
| `jours_feries[]` | non | Dates `AAAA-MM-JJ` où l'entreprise est fermée |

Puis recharger sans redémarrer :

```bash
curl -X POST https://votre-domaine.ca/api/recharger -H "X-Cle-Admin: $CLE_ADMIN"
```

**Le champ `mots_cles` fait l'acheminement.** L'agent transfère à la personne
dont un mot-clé apparaît dans la demande. Des mots-clés précis et sans
recoupement entre membres donnent un routage fiable.

---

## Console d'administration

`https://votre-domaine.ca/console`, avec la valeur de `CLE_ADMIN`.

Par client : statistiques sur 30 jours, journal des appels avec transcription
intégrale, messages pris, rendez-vous fixés.

### API

Toutes les routes exigent l'en-tête `X-Cle-Admin`.

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/sante` | État du service (publique) |
| `GET` | `/api/clients` | Clients et statistiques |
| `GET` | `/api/clients/:id` | Fiche complète |
| `PUT` | `/api/clients/:id` | Remplacer la fiche |
| `GET` | `/api/clients/:id/appels` | Journal des appels |
| `GET` | `/api/appels/:id` | Détail et transcription |
| `GET` | `/api/clients/:id/messages` | Messages pris |
| `GET` | `/api/clients/:id/rendezvous` | Rendez-vous |
| `POST` | `/api/recharger` | Relire les fiches depuis le disque |

---

## Réglages du moteur

| Variable | Défaut | Effet |
|---|---|---|
| `EFFORT_LLM` | `low` | Profondeur de raisonnement. `low` pour la latence, `medium` si l'agent traite des demandes complexes |
| `MODELE_STT` | `nova-2` | Modèle Deepgram. `nova-2` a le meilleur français canadien |
| `MODELE_TTS` | `eleven_flash_v2_5` | Modèle ElevenLabs. `flash` est le plus rapide |
| `FALLBACK_LLM` | `true` | Bascule serveur vers un modèle de repli si un refus survient |

Deux réglages fins dans le code, à ajuster selon les retours d'appels réels :

- `endpointing: '500'` dans `src/moteur/stt.js` — durée de silence avant que
  l'agent considère le tour de parole terminé. Plus bas = plus réactif, mais
  l'agent coupe les appelants qui hésitent.
- La synthèse est déclenchée phrase par phrase (`TamponPhrases` dans
  `cerveau.js`) plutôt qu'à la fin de la génération : c'est ce qui donne un
  temps de réponse perçu court même quand la réponse est longue.

**Pourquoi le raisonnement reste activé.** Sur `claude-opus-5`, désactiver le
raisonnement fait parfois écrire un appel d'outil en texte visible plutôt qu'en
bloc structuré : l'outil ne s'exécute jamais, sans erreur, et l'appelant
n'obtient rien. Le raisonnement adaptatif à effort `low` évite ce mode de
défaillance tout en gardant la latence basse.

---

## Coût par appel

Ordre de grandeur pour un appel de trois minutes, aux tarifs publics de 2026 :

| Poste | Coût |
|---|---|
| Téléphonie entrante | ~0,03 $ |
| Reconnaissance vocale | ~0,02 $ |
| Synthèse vocale | ~0,09 $ |
| Modèle de langue | ~0,06 $ |
| **Total** | **~0,20 $ CA** |

À 250 appels par mois, cela représente environ 50 $ de coûts variables. Les
forfaits affichés sur le site vitrine sont construits sur cette base.

---

## Ce qui reste à faire avant la première vente

1. **Acheter un vrai numéro Twilio** et remplacer le numéro fictif
   `+14185550142` dans `crc.json`.
2. **Choisir la voix** et remplir `voix_id`.
3. **Remplir les téléphones de l'équipe** dans `crc.json` — aucun membre n'a
   de numéro pour l'instant, donc tous les transferts iront au numéro de
   repli 418 365-7973.
4. **Notifications par courriel** — les variables `SMTP_*` sont prévues mais
   l'envoi n'est pas encore branché ; les messages sont consignés en base et
   visibles dans la console.
5. **Tester en conditions réelles** : appeler l'agent, essayer de le piéger,
   ajuster la FAQ et les mots-clés d'après les transcriptions.

---

## Structure

```
agent-vocal/
├── data/clients/crc.json          fiche du premier client
├── scripts/verif-config.js        validation avant mise en service
└── src/
    ├── server.js                  routes HTTP + WebSocket audio
    ├── config.js                  variables d'environnement
    ├── clients.js                 chargement des fiches
    ├── horaire.js                 heures d'ouverture et disponibilités
    ├── db.js                      SQLite (appels, messages, rendez-vous)
    ├── moteur/
    │   ├── session.js             orchestration d'un appel
    │   ├── cerveau.js             Claude, prompt, boucle d'outils
    │   ├── outils.js              outils métier
    │   ├── stt.js                 Deepgram
    │   └── tts.js                 ElevenLabs
    ├── telephonie/
    │   ├── twilio.js              TwiML, Media Streams, transfert, SMS
    │   └── telus-business-connect.js   RingCentral : SMS, journal, renvoi
    └── web/
        ├── site.html              site vitrine
        └── console.html           console d'administration
```
