# Polices de sous-titres

Depose ici un `.ttf` ou `.otf`. Quand ce dossier contient une police, FFmpeg
recoit `fontsdir` et la resout par le nom declare dans
`config/channel.*.json` -> `captions.fontName`.

Sans police locale, le rendu retombe sur les polices systeme
(`captions.fontFallbacks`), ce qui donne un resultat correct mais pas identique
d'une machine a l'autre. Pour que le rendu soit reproductible entre le PC
Windows et n'importe quelle autre machine, depose la police ici.

## Recommandation

Montserrat ExtraBold (SIL Open Font License, gratuite, commercialisable) :
telecharger la famille sur Google Fonts, deposer `Montserrat-ExtraBold.ttf` ici,
et laisser `captions.fontName` a `"Montserrat ExtraBold"`.

Le nom a mettre dans `fontName` est le nom **interne** de la police, pas le nom
de fichier. En cas de doute :

    ffprobe -v error -show_entries stream_tags -i Montserrat-ExtraBold.ttf

ou, plus simplement, rends une video de test et verifie la premiere image.
