# Opera Add-ons — fiche de l'extension

Opera installe le **paquet Chromium** (`dist/chrome.zip`), et sait aussi installer les
extensions du Chrome Web Store (*Install Chrome Extensions*) : une fiche ici est donc
facultative. Si on en publie une, c'est sur
[addons.opera.com](https://addons.opera.com/developer/).

## Image promotionnelle

Opera en **exige** une, au format 300 × 188 : [`promo-300x188.png`](promo-300x188.png),
régénérée par `scripts/brand-assets.mjs`. C'est la seule boutique qui demande ce format.

## Description courte

> Mesure la rédaction dans Google Docs et Word Online : seulement des compteurs. Votre document
> n'est envoyé que si vous le déposez.

## Description

> Certimens aide les enseignants à vérifier qu'un travail écrit a bien été rédigé par
> l'étudiant qui le rend.
>
> Pendant que vous écrivez dans Google Docs ou Word Online, l'extension tient des compteurs sur
> votre façon de rédiger : frappes, temps de rédaction effectif, pauses, corrections,
> reformulations, déplacements, textes collés. Ces compteurs partent vers l'espace Certimens de
> votre établissement, où l'enseignant consulte le déroulé de la rédaction.
>
> Le texte que vous saisissez n'est jamais enregistré ni envoyé. Le document n'est transmis que
> lorsque vous cliquez sur « Envoyer le .docx ».
>
> Un compte Certimens, fourni par votre établissement, est nécessaire.

## Catégorie

**Accessibilité** ou **Productivité** — Opera n'a pas de catégorie « éducation ».

## Confidentialité

URL : `https://certimens.fr/politique-de-confidentialite/`. Les justifications de permissions
sont celles de [`../chrome/`](../chrome/) : Opera ne les demande pas champ par champ, mais la
revue peut les réclamer.

## Publication automatisée

Opera **n'a pas d'API**. La release utilise le cookie `sessionid` du compte développeur
(secret `OPERA_SESSION_ID`), qui expire : quand la publication échoue, c'est en général lui
qu'il faut renouveler (voir `docs/publication.md`).
