# faceless-studio

Production automatisee de Shorts verticaux faceless : Claude ecrit le script,
un TTS le dit, une banque d'images le montre, FFmpeg assemble, et tu recois un
MP4 pret a publier avec son titre, sa description et ses tags.

Sortie par video : `out/<date>_<slug>/`

    video.mp4          1080x1920, 30 fps, audio normalise a -14 LUFS
    cover.jpg          image extraite pour la vignette
    metadata.json      titre, description, tags, timings, credits, divulgation IA
    PUBLISH.md         fiche de publication avec cases a cocher
    script.txt         la narration, beat par beat

Le pipeline s'arrete **avant** la publication : tu valides, tu publies. C'est un
choix, pas une limite — voir « Pourquoi pas d'upload automatique » plus bas.

Le choix de niche et le plan de croissance sont dans [STRATEGY.md](STRATEGY.md).

---

## Installation

```bash
cd faceless-studio
npm install                 # installe aussi un FFmpeg statique, rien a installer a la main
cp .env.example .env        # puis remplir les cles
npm run doctor              # verifie tout et dit precisement ce qui manque
```

`npm run doctor` est le point d'entree quand quelque chose ne va pas. Il verifie
Node, FFmpeg, la config, chaque cle API, les polices et les pistes musicales.

### Cles necessaires

| Service | Role | Requis | Cout indicatif |
|---|---|---|---|
| Anthropic | idees + scripts | oui | ~0,10 $ par video |
| ElevenLabs | voix off **avec timings par caractere** | recommande | ~22 $/mois pour ~130 videos |
| OpenAI TTS | voix off, sans timings | alternative | moins cher, sous-titres estimes |
| Pexels | banque video et photo | recommande | gratuit |
| Pollinations | images IA | non | gratuit, sans cle |

**Pourquoi ElevenLabs plutot qu'un TTS moins cher :** c'est le seul des deux qui
retourne le temps de debut et de fin de chaque caractere. C'est ce qui permet le
sous-titrage mot-a-mot exactement synchrone — la caracteristique visuelle qui
tient l'attention sur ce format. Avec OpenAI, le pipeline estime les timings au
prorata de la longueur des mots : correct, mais visiblement moins net.

**Cout total :** environ 0,30 $ par video, soit ~9 $/mois a une video par jour.

### Deux dossiers a remplir

- `assets/music/` — au moins une piste de fond ([details](assets/music/README.md))
- `assets/fonts/` — Montserrat ExtraBold ou equivalent ([details](assets/fonts/README.md))

Les deux sont optionnels : sans musique le rendu se fait sur la voix seule, sans
police locale il retombe sur les polices systeme.

---

## Utilisation

```bash
npm run ideas -- --count 12     # genere 12 idees et les banque
npm run make                    # produit la prochaine idee en attente
npm run batch -- --count 3      # produit 3 videos d'affilee
npm run list                    # etat de la banque et des videos produites
npm run review                  # (re)genere out/review.html
```

Le rythme normal : `npm run ideas -- --count 14` une fois par semaine, puis
`npm run make` chaque matin. Ouvre `out/review.html` pour valider — la page
montre chaque video avec son titre, sa description et ses tags en un clic-copie.

### Options

| Option | Effet |
|---|---|
| `--config <chemin>` | autre fichier de chaine (defaut : `$CHANNEL_CONFIG`) |
| `--idea <id\|slug>` | produire une idee precise plutot que la prochaine |
| `--keep-work` | conserver les fichiers intermediaires (beats audio, visuels, `.ass`) |

`--keep-work` est ce qu'il faut activer pour diagnostiquer un rendu : le
`captions.ass` et les MP3 par beat restent dans `out/<video>/work/`.

---

## Comment ca marche

    idee ──► script ──► voix ──► timeline ──► visuels ──► sous-titres ──► rendu ──► package
             Claude     TTS      calculee     Pexels      .ass mot-a-mot   FFmpeg   PUBLISH.md
                                 des durees   ou IA       burn-in          1 passe
                                 audio reelles

Le point important est la **timeline**. Les durees ne sont pas devinees : chaque
beat est synthetise separement, sa duree reelle est mesuree, et c'est elle qui
fixe la duree de la scene visuelle correspondante. Les changements de plan
tombent donc exactement sur les changements de phrase, et les sous-titres sont
alignes sur l'audio et non sur une estimation.

Le rendu final est **une seule passe FFmpeg**. Le filtre `concat` impose
lui-meme une geometrie identique entre les scenes, ce qui elimine la classe de
bugs ou le demuxer `concat` recoud silencieusement des plans incompatibles.

### La rotation des formats

`config/channel.mindloop.json` definit six formats. Chacun a sa propre
structure narrative, son langage visuel, son rythme et sa couleur de sous-titre.
Le code — pas le modele — impose la rotation : un meme format ne peut pas
revenir avant 4 uploads.

Ce n'est pas cosmetique. La politique YouTube de « contenu non authentique »
demonetise les videos produites en serie a partir d'un gabarit. Six structures
en rotation, plus ta validation manuelle, sont la reponse directe a ce critere.
`test/rotation.mjs` verifie l'invariant sur 60 uploads simules.

### Pourquoi pas d'upload automatique

C'est techniquement faisable (YouTube Data API + Graph API) et volontairement
absent. Une chaine neuve qui publie via API sans aucun passage humain est le
profil exact que la moderation anti-spam cible. Le gain — trente secondes par
jour — ne vaut pas le risque sur le compte. Quand la chaine aura un historique
et que les formats seront stabilises, c'est un ajout de quelques heures.

---

## Configuration de la chaine

Tout est dans un seul fichier JSON. Pour lancer une seconde chaine, copie-le et
pointe `CHANNEL_CONFIG` dessus — aucun code a toucher.

| Section | Ce qu'elle regle |
|---|---|
| `channel` | identite, promesse, ton, interdits editoriaux, divulgation IA |
| `video` | dimensions, fps, duree cible, codecs, cible de loudness |
| `audio` | gains voix/musique, fondus, pauses entre beats |
| `captions` | police, taille, mots par groupe, position, couleurs |
| `script` | modele Claude, effort, nombre de beats, mots par seconde |
| `variation` | profondeur des fenetres anti-repetition |
| `formats[]` | les six structures narratives et leur langage visuel |
| `topicSeeds[]` | le terrain de jeu thematique de l'ideation |
| `publishing` | cadence, creneaux, gabarit de description, surfaces |

Les deux reglages a ajuster en premier :

- **`script.wordsPerSecond`** (defaut 2.6). Si tes videos sortent trop courtes
  ou trop longues, c'est ce chiffre qu'il faut corriger, pas `targetSeconds` :
  il traduit un budget de mots en duree pour la voix que tu utilises.
- **`formats[].hookPattern`**. C'est le levier de croissance. Quand YouTube
  Studio te montre quels hooks tiennent a 3 secondes, reecris ces lignes.

---

## Tests

```bash
node test/rotation.mjs          # invariant de rotation sur 60 uploads simules
node test/claude-contract.mjs   # requetes et schemas Claude, contre une API locale
node test/e2e-render.mjs        # pipeline complet, script fourni, sans reseau
node test/render-branches.mjs   # source video (boucle + recadrage) et mix musique
```

Aucun ne consomme de credit ni ne touche au reseau : les deux derniers tournent
en `TTS_PROVIDER=silent` / `VISUALS_PROVIDER=solid`, et `claude-contract`
interroge un serveur HTTP local qui rejoue une reponse valide.

Lance-les apres toute modification de `src/lib/ass.js`, `src/steps/render.js`
ou de la config : ce sont les trois endroits ou une erreur ne se voit qu'a
l'image.

## Diagnostic

| Symptome | Cause probable |
|---|---|
| `ffmpeg introuvable` | `npm install` non lance, ou definir `FFMPEG_PATH` |
| Sous-titres dans la mauvaise police | pas de `.ttf` dans `assets/fonts/`, ou `captions.fontName` ne correspond pas au nom interne de la police |
| Videos systematiquement trop courtes | ajuster `script.wordsPerSecond` |
| `placeholder utilise` sur tous les beats | `PEXELS_API_KEY` absente ou quota atteint |
| Sous-titres legerement decales | TTS sans timings — passer a ElevenLabs |
| Musique inaudible | aucune piste dans `assets/music/`, ou `audio.musicGainDb` trop bas |

`DEBUG=1` devant n'importe quelle commande affiche la stack complete.
