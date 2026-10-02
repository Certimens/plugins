# Edge Add-ons — fiche de l'extension

Textes à copier dans le
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge). Edge installe le
**paquet Chromium** : `dist/chrome.zip`, le même fichier que le Chrome Web Store.

La fiche se remplit langue par langue (*Store listings* a un onglet par langue) : le paquet
porte le nom et la description en français et en anglais, le Partner Center ne les en déduit
pas.

## Description courte

Le Partner Center la reprend du manifest si on le laisse faire ; autant la coller telle quelle :

> Mesure la rédaction dans Google Docs et Word Online : seulement des compteurs. Votre document
> n'est envoyé que si vous le déposez.

## Description

> Certimens aide les enseignants à vérifier qu'un travail écrit a bien été rédigé par
> l'étudiant qui le rend.
>
> Pendant que vous écrivez dans Google Docs ou Word Online, l'extension tient des compteurs sur
> votre façon de rédiger : frappes, temps de rédaction effectif, pauses, corrections,
> reformulations, déplacements, textes collés. Ces compteurs partent vers l'espace Certimens de
> votre établissement.
>
> Le texte que vous saisissez n'est jamais enregistré ni envoyé : seule la catégorie d'une
> touche est comptée. Le document n'est transmis que lorsque vous cliquez sur
> « Envoyer le .docx ».
>
> Un compte Certimens, fourni par votre établissement, est nécessaire.

## Catégorie

**Productivité** (Edge n'a pas de catégorie « éducation »).

## Visuels

- Logo : les icônes du paquet suffisent (`icons/icon128.png`).
- Capture : [`../chrome/screenshot-1280x800.png`](../chrome/screenshot-1280x800.png) — Edge
  accepte le même format que le Chrome Web Store.

## Confidentialité et permissions

Le questionnaire est plus court que celui de Chrome, mais il porte sur les mêmes faits :
reprendre les justifications de [`../chrome/`](../chrome/) pour `storage`, `alarms` et les
hôtes. À déclarer :

- l'extension **collecte** des données personnelles (e-mail et jeton, activité de rédaction,
  document déposé par l'étudiant) ;
- URL de confidentialité : `https://certimens.fr/politique-de-confidentialite/` ;
- aucune revente, aucun tiers, aucune publicité.
