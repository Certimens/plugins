# App Store — l'extension Safari

Safari n'accepte une extension **qu'embarquée dans une app**. `make -C browser safari`
convertit `dist/safari/` en projet Xcode (app macOS **et** iOS, identifiant de paquet
`fr.certimens.agent`), que l'on signe et soumet depuis Xcode : rien n'est automatisable ici, et
l'App Store demande une fiche d'**application**, pas d'extension.

Prérequis : l'[Apple Developer Program](https://developer.apple.com/programs/) (99 $/an) et un
Mac. Les étapes de signature et d'archivage sont dans
[`docs/publication.md`](../../../docs/publication.md).

## Nom et sous-titre

| Champ | Français | English |
| --- | --- | --- |
| Nom (30 car.) | Certimens | Certimens |
| Sous-titre (30 car.) | Agent de rédaction | Writing agent |

Le nom de l'app ne peut pas porter le tiret cadratin et tenir en 30 caractères : c'est le
sous-titre qui porte « Agent de rédaction ».

## Description

> Certimens aide les enseignants à vérifier qu'un travail écrit a bien été rédigé par
> l'étudiant qui le rend.
>
> Cette app installe l'extension Safari du même nom. Pendant que vous écrivez dans Google Docs
> ou Word Online, l'extension tient des compteurs sur votre façon de rédiger : frappes, temps
> de rédaction effectif, pauses, corrections, reformulations, déplacements, textes collés. Ces
> compteurs partent vers l'espace Certimens de votre établissement, où l'enseignant consulte le
> déroulé de la rédaction.
>
> Le texte que vous saisissez n'est jamais enregistré ni envoyé : seule la catégorie d'une
> touche est comptée. Le document n'est transmis que lorsque vous cliquez sur
> « Envoyer le .docx ».
>
> Pour activer l'extension : Safari › Réglages › Extensions, cocher Certimens, puis autoriser
> l'accès à docs.google.com et aux adresses de Word Online.
>
> Un compte Certimens, fourni par votre établissement, est nécessaire.

## Mots-clés (100 caractères, séparés par des virgules)

> certimens,rédaction,devoir,enseignant,étudiant,intégrité,google docs,word

## Catégorie et classification

- Catégorie principale : **Éducation** ; secondaire : **Productivité**.
- Classification par âge : 4+ (aucun contenu généré, aucune publicité).

## Adresses

| Champ | Valeur |
| --- | --- |
| URL d'assistance | https://certimens.fr |
| URL marketing | https://certimens.fr |
| Politique de confidentialité | https://certimens.fr/politique-de-confidentialite/ |

## Confidentialité de l'app (questionnaire App Store)

À déclarer, **liées à l'identité de l'utilisateur** et **non utilisées pour le suivi** :

- **Coordonnées** → adresse e-mail : l'e-mail Certimens saisi à la connexion. Finalité :
  fonctionnalité de l'app.
- **Identifiants** → ID utilisateur : le jeton d'accès créé à la connexion (le mot de passe
  n'est pas conservé). Finalité : fonctionnalité de l'app.
- **Utilisation** → données d'utilisation du produit : les compteurs de rédaction. Finalité :
  fonctionnalité de l'app.
- **Contenu utilisateur** → autre contenu : le document .docx, **uniquement** quand l'étudiant
  le dépose. Finalité : fonctionnalité de l'app.

Aucune donnée n'est utilisée à des fins publicitaires, de suivi ni d'analyse tierce.

## Captures d'écran

Exigées **par plateforme** (macOS et iOS), à faire depuis les apps construites par Xcode :
l'app affiche l'écran d'activation, et l'extension sa fenêtre ouverte sur un Google Doc. La
capture du Chrome Web Store ([`../chrome/screenshot-1280x800.png`](../chrome/screenshot-1280x800.png))
n'est pas aux dimensions attendues par l'App Store.

## Notes pour la revue

> L'app sert à distribuer une extension Safari, conformément au modèle
> « Safari Web Extension ». Compte de test : e-mail `<à renseigner>`, mot de passe
> `<à renseigner>`. L'adresse du moteur n'est pas à saisir : elle vaut celle par défaut, et vit
> dans les paramètres avancés du formulaire.
>
> Activer l'extension dans Safari › Réglages › Extensions, ouvrir un document sur
> https://docs.google.com/document/, puis se connecter depuis la fenêtre de l'extension.
