# AppSource (Partner Center) — fiche du complément Word

Textes à copier dans l'offre *Complément Office* du Partner Center. Ils décrivent ce que fait le
code actuel de l'agent : à revoir si le complément change. C'est la seule boutique du
complément Word — le site lui-même est publié sur GitHub Pages par la release. Le manifest porte déjà le nom et la
description en anglais (`<Override Locale="en-us">`) ; la fiche AppSource, elle, se remplit langue
par langue dans le Partner Center. Les formats d'images et limites de
longueur sont affichés par le Partner Center à côté de chaque champ : s'y fier en cas d'écart.

## Nom

> Certimens — Agent de rédaction

## Description courte

> Mesure la rédaction dans Word et l'envoie à votre espace Certimens. Aucun texte enregistré.

## Description longue

> Certimens aide les enseignants à vérifier qu'un travail écrit a bien été rédigé par
> l'étudiant qui le rend.
>
> Pendant que l'étudiant écrit dans Word, le complément tient des compteurs sur sa façon de
> rédiger : caractères saisis, temps de rédaction effectif, pauses de réflexion, corrections,
> reformulations, déplacements dans le document et textes collés. Ces compteurs sont envoyés à
> son espace Certimens, où l'enseignant consulte le déroulé de la rédaction.
>
> Depuis le volet Certimens, l'étudiant :
>
> - connecte le volet à son espace Certimens, avec un code court et sans mot de passe ;
> - associe le document à un document Certimens ;
> - le rend sur un devoir de sa classe ;
> - envoie la version .docx du document.
>
> Respect de la vie privée : le texte saisi n'est jamais enregistré ni envoyé pendant la
> mesure. Seuls des compteurs partent au serveur. Le document lui-même n'est envoyé que
> lorsque l'étudiant clique sur « Envoyer le .docx ».
>
> Un compte Certimens, fourni par l'établissement, est nécessaire.

## Catégories

- Éducation
- Productivité

## Adresses

| Champ                           | Valeur                                           |
| ------------------------------- | ------------------------------------------------ |
| Site / support                  | https://certimens.fr                             |
| Contact (assistance)            | contact@certimens.fr                             |
| Règles de confidentialité       | **à créer** (page publique sur certimens.fr)     |
| Conditions d'utilisation (CLUF) | **à créer**, ou le contrat standard de Microsoft |

La page de confidentialité peut être la même que celle demandée par le Chrome Web Store
([`browser/store/chrome/`](../../../browser/store/chrome/)), avec une mention du complément
Word.

## Images

- Logo : [`logo-300x300.png`](logo-300x300.png) (l'écu doré sur l'ardoise de la charte,
  régénéré par `scripts/brand-assets.mjs`).
- Captures d'écran : le volet ouvert dans Word, à faire depuis un vrai Word une fois le
  complément en ligne sur GitHub Pages.

## Notes pour les testeurs de Microsoft

À remplir avec un compte de démonstration **dédié** (rôle étudiant, rattaché à une classe qui a
au moins un devoir **dont l'échéance est à venir** — le volet retire le rendu et l'envoi d'une
copie dont l'échéance est passée, et le testeur ne verrait plus ces boutons), sur le moteur de
production :

> Le complément nécessite un compte Certimens. **Il ne demande aucun mot de passe** : il affiche
> un code court, que l'on confirme une fois connecté à https://monespace.certimens.fr, et reçoit
> en retour un jeton d'API. Le compte de test — E-mail : `<à renseigner>`, mot de passe :
> `<à renseigner>` — est donc celui de ce site, pas du volet. L'adresse du moteur n'est pas à
> saisir : elle vaut celle par défaut, et vit dans les paramètres avancés.
>
> 1. Ouvrir un document Word, onglet Accueil › Certimens.
> 2. Cliquer sur « Se connecter », ouvrir l'espace Certimens avec le bouton proposé, s'y
>    connecter avec le compte ci-dessus et y confirmer le code affiché. Le volet reste ouvert
>    pendant ce temps et se connecte de lui-même.
> 3. Cliquer sur « Créer le document » (choisir le devoir « … » pour tester le rendu).
> 4. Écrire quelques phrases : les compteurs sont envoyés après 2 secondes sans frappe ; le
>    volet affiche « Mesures à jour. ».
> 5. « Envoyer le .docx » envoie le document au document Certimens ; « Ouvrir dans Certimens »
>    l'affiche dans l'espace de l'étudiant.
>
> Le complément fonctionne dans Word pour Windows et Mac (Microsoft 365) et Word sur le web ; il
> exige le runtime partagé (SharedRuntime 1.1), absent de Word 2016/2019 pour Windows.

## Données (questionnaire de conformité)

- **Données collectées** : e-mail Certimens et un jeton d'accès remis à l'appairage (aucun mot
  de passe n'est demandé ni conservé), gardés dans le stockage local du complément ;
  compteurs de rédaction ; titre et nombre de caractères du document ; le document .docx,
  seulement sur demande de l'étudiant.
- **Destination** : uniquement le serveur Certimens de l'établissement (par défaut
  monespace.certimens.fr). Aucun tiers, aucune publicité, aucune revente.
- **Code distant** : seul Office.js est chargé depuis le CDN de Microsoft, comme l'exige
  AppSource ; tout le reste est servi par le site du complément.
