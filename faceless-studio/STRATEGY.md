# Choix de niche et plan de croissance

Tu as demande « trouve-moi ce qui cartonne » plutot que de choisir une niche
toi-meme. Voici ce que la recherche donne en aout 2026, la niche retenue, et
pourquoi.

## Ce que dit le marche

| Signal | Constat |
|---|---|
| Volume | Shorts depasse 200 milliards de vues par jour (contre ~70 milliards debut 2024). Le marche s'est elargi, il ne s'est pas sature. |
| Duree optimale | Les Shorts de 50-60 s surperforment les formats plus courts, avec des taux de completion autour de 76 %. |
| Seuil de monetisation | Deux voies : 1 000 abonnes + 10 M de vues Shorts sur 90 jours, **ou** 1 000 abonnes + 4 000 heures de visionnement. |
| Risque principal | Depuis juillet 2025, la politique « contenu repetitif » est devenue « contenu non authentique ». Le critere n'est pas « fait par IA », c'est « produit en serie a partir d'un gabarit, sans apport editorial reel ». |

## Les niches, classees

| Niche | RPM Shorts | Volume de vues | Automatisable | Verdict |
|---|---|---|---|---|
| Finance / investissement | Le plus eleve (10-25 $ / 1000 vues en equivalent long) | Moyen | Oui | Saturation extreme + moderation severe. Mauvais premier choix. |
| **Psychologie / comportement humain** | **Moyen (tier 2)** | **Eleve** | **Tres bien** | **Retenu.** |
| Tech / IA | Eleve | Moyen-eleve | Oui | Bon second couloir, mais perissable : chaque video vieillit en 3 mois. |
| Horreur / creepypasta | Faible (3-7 $ CPM) | Le plus eleve | Tres bien | Le plus facile pour du volume, le plus dur a monetiser et le plus sature. |
| Histoire / documentaire | Moyen | Eleve | Oui | Solide, mais production visuelle plus lourde (archives, droits). |
| True crime | Moyen | Eleve | Moyen | Risque editorial reel : personnes nommees, affaires en cours. |

## Niche retenue : psychologie appliquee / comportement humain

Chaine configuree : **MindLoop** (`config/channel.mindloop.json`).

Les quatre raisons :

1. **Le meilleur produit volume x RPM.** Tier 2 en revenu par vue, mais un
   volume de vues nettement superieur aux niches tier 1. Les canaux de ce
   type atteignent 1 000 abonnes en 2-4 mois en publiant tous les jours.
2. **Les hooks s'ecrivent tout seuls.** « Les gens qui font X sont en realite
   Y » arrete le pouce parce que le spectateur se reconnait. Les angles sont
   inepuisables : relations, travail, biais cognitifs.
3. **Le sujet survit a la politique de contenu non authentique.** Chaque video
   porte une *affirmation distincte*, pas un gabarit rempli differemment.
   C'est exactement ce que la politique demande.
4. **Zero visage requis, et le stock footage colle.** « Quai de metro bonde »,
   « salle d'attente vide » : ce sont des requetes que Pexels sait servir.
   Une niche comme la finance demande des graphiques, donc de la production.

### Le risque a surveiller

La derive vers le vocabulaire therapeutique (« narcissique », « trauma »,
« gaslighting ») utilise a la legere. C'est la porte d'entree vers un
signalement de desinformation medicale, et c'est explicitement interdit dans la
config (`channel.forbidden`). Chaque affirmation doit nommer son mecanisme —
le champ `groundedIn` de chaque idee et `sourceNote` de chaque script existent
pour ca, et ils remontent dans la description publiee.

### Le second couloir, plus tard

Ne lance pas deux chaines en meme temps. Quand MindLoop tourne sans toi,
duplique la config vers une chaine « tech / IA expliquee » : meme pipeline,
seul le fichier de config change (`CHANNEL_CONFIG=config/channel.xxx.json`).
Le RPM y est nettement meilleur.

## Le mecanisme anti-demonetisation, concretement

La politique de contenu non authentique vise « les videos qui suivent un
gabarit avec peu de variation, reproduites a l'echelle, sans apport reel de
l'auteur ». Trois choses dans ce pipeline repondent directement a ca :

1. **Six formats structurellement differents**, en rotation forcee dans le
   code (`planFormats`) et non laissee au modele. Une meme structure ne peut
   pas revenir avant 4 uploads. Le test `test/rotation.mjs` verifie
   l'invariant sur 60 uploads simules.
2. **Chaque format a son propre langage visuel, son rythme et sa couleur de
   sous-titres.** Deux videos consecutives ne se ressemblent pas a l'ecran,
   pas seulement dans le texte.
3. **Tu es dans la boucle.** Le pipeline s'arrete au MP4 + `PUBLISH.md`. Ton
   passage de 30 secondes avant publication *est* l'apport editorial. C'est
   aussi ce qui evite un strike pour spam sur un compte neuf.

## Cadence et attentes realistes

**Cadence : 1 video par jour.** Deux par jour n'accelere presque rien au debut
et double le cout. Trois par semaine est trop lent pour donner du signal a
l'algorithme.

**Ce a quoi il faut s'attendre**, sans enrobage :

- Videos 1 a 20 : quelques centaines de vues chacune. Normal. La chaine n'a
  aucun historique, l'algorithme ne sait pas a qui la montrer.
- Videos 20 a 60 : une ou deux videos vont sortir du lot (10k-100k). C'est le
  signal. **Regarde laquelle, et pourquoi** — c'est la seule donnee qui compte.
- Le seuil de 10 M de vues Shorts sur 90 jours est atteignable seulement apres
  qu'un format ait trouve son audience. Vise d'abord 1 000 abonnes.

**La boucle d'amelioration.** Toutes les deux semaines, ouvre YouTube Studio et
regarde la retention a 3 secondes. Les hooks qui tiennent, ajoute-les comme
`hookPattern` d'un format dans la config. Ceux qui decrochent, retire-les. Le
pipeline ne s'ameliore pas tout seul : c'est ce reglage de la config qui le
fait progresser.

## Multi-plateforme

Le meme MP4 vertical 1080x1920 va sur Shorts, Reels (Facebook et Instagram) et
TikTok sans retouche. `PUBLISH.md` liste les quatre surfaces en cases a cocher.

Facebook Reels merite d'etre pris au serieux : l'audience y est plus agee, la
concurrence sur ce type de contenu y est plus faible, et le programme de
monetisation des Reels paie sur des vues que YouTube ne compterait pas. Cout
marginal : zero, la video est deja rendue.

## Sources

- [Best Niches for YouTube Shorts in 2026 (With RPM Estimates) — Miraflow](https://miraflow.ai/blog/best-niches-youtube-shorts-2026-rpm-estimates)
- [The Faceless YouTube Channel Explosion — Miraflow](https://miraflow.ai/blog/faceless-youtube-channel-explosion-ai-million-subscriber-creators-2026)
- [18 Best Faceless YouTube Niches in 2026 — Fliki](https://fliki.ai/blog/best-faceless-youtube-niches)
- [10 Best Faceless YouTube Niches for 2026 (by RPM) — Kineclip](https://kineclip.com/blog/best-niches-faceless-youtube-2026/)
- [YouTube Inauthentic Content Policy 2026 — ARWriter](https://arwriterai.com/en/blog/youtube-inauthentic-content-policy-ai-creators-2026/)
- [YouTube Monetization with AI Content: What's Allowed — Miraflow](https://miraflow.ai/blog/youtube-monetization-ai-content-2026-allowed-demonetized)
- [Faceless Shorts Strategy 2026 — Virvid](https://virvid.ai/blog/faceless-shorts-dominance-strategy-2026)

Note sur ces sources : ce sont pour l'essentiel des blogs d'editeurs d'outils
video IA, donc interesses. Les chiffres de RPM sont a lire comme des ordres de
grandeur, pas comme des mesures. Les deux faits verifiables ailleurs et sur
lesquels repose la strategie sont le seuil de monetisation Shorts et la
politique de contenu non authentique de juillet 2025.
