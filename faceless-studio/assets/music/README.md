# Pistes de fond

Depose ici des fichiers `.mp3` / `.m4a` / `.wav`. Le pipeline en choisit une par
video en rotation, de sorte que deux uploads consecutifs ne partagent pas le meme
lit sonore.

Sans piste, le rendu se fait sans musique (la voix seule reste normalisee a -14 LUFS).

## Ce qui marche pour ce format

- Ambient / drone sombre, sans percussion marquee, 60-90 BPM
- Aucune melodie qui attire l'oreille : la piste doit soutenir la voix, pas la concurrencer
- 1 a 2 minutes suffisent, le pipeline boucle automatiquement

## Licence - a verifier avant de deposer

N'utilise que des pistes dont tu peux prouver la licence. Une reclamation
Content ID sur un Short bloque la monetisation de la video entiere.

Sources sures : YouTube Audio Library, Pixabay Music, Free Music Archive
(verifier piste par piste), ou une licence payante (Epidemic Sound, Artlist).

Le nom du fichier est repris tel quel dans `metadata.json` et `PUBLISH.md` :
nomme-le de facon a retrouver la licence plus tard, ex.
`epidemic-quiet-mechanism-2026.mp3`.
