# addons.mozilla.org — fiche de l'extension Firefox

Textes à copier dans le [Developer Hub](https://addons.mozilla.org/developers/). Ils décrivent
ce que fait le code actuel (`browser/`) : à revoir si une autorisation change. Paquet :
`dist/firefox.zip`, construit par `make build`.

AMO reprend le nom et la description courte du manifest, mais **pas les traductions des champs
de la fiche** : l'onglet par langue se remplit à la main, en français et en anglais.

## Ce que le manifest impose déjà

| Champ | Valeur | Où |
| --- | --- | --- |
| ID | `agent@certimens.fr` | `browser_specific_settings.gecko.id` |
| Version minimale | Firefox 140 (Android 142) | `strict_min_version` |
| Données déclarées | `authenticationInfo`, `websiteActivity`, `websiteContent` | `data_collection_permissions` |

L'**ID ne peut plus changer** une fois la première version publiée. Les trois catégories de
données sont celles que Firefox affiche à l'installation : elles doivent rester le reflet exact
de ce que l'extension collecte, et `make -C browser lint-amo` traite tout écart comme une
erreur.

## Résumé (250 caractères maximum)

> Mesure la façon dont vous rédigez dans Google Docs et Word Online — rythme, pauses,
> corrections, collages — et envoie ces compteurs à votre espace Certimens. Aucun texte, aucune
> touche n'est enregistré. Votre document n'est envoyé que si vous le déposez.

> Measures how you write in Google Docs and Word Online — rhythm, pauses, corrections, pastes —
> and sends those counters to your Certimens space. No text, no keystroke is ever recorded. Your
> document is sent only when you submit it.

## Description

> Certimens aide les enseignants à vérifier qu'un travail écrit a bien été rédigé par
> l'étudiant qui le rend.
>
> Pendant que vous écrivez dans Google Docs ou Word Online, l'extension tient des compteurs sur
> votre façon de rédiger : frappes, temps de rédaction effectif, pauses de réflexion,
> corrections, reformulations, déplacements dans le document, textes collés. Ces compteurs
> partent vers l'espace Certimens de votre établissement, où l'enseignant consulte le déroulé
> de la rédaction.
>
> Depuis la fenêtre de l'extension, vous pouvez associer le document ouvert à un document
> Certimens, le rendre sur un devoir de votre classe, envoyer sa version .docx, et suspendre la
> mesure à tout moment.
>
> **Vie privée** : le texte que vous saisissez n'est jamais enregistré ni envoyé. Seule la
> catégorie d'une touche est comptée (caractère, effacement, flèche…), jamais la touche
> elle-même. Le document n'est transmis que lorsque vous cliquez sur « Envoyer le .docx ».
>
> Un compte Certimens, fourni par votre établissement, est nécessaire.

## Catégorie et étiquettes

- Catégorie : **Autre** (aucune catégorie « éducation » sur AMO pour les extensions).
- Étiquettes : `certimens`, `education`, `writing`, `integrity`.

## Notes pour les évaluateurs

AMO relit le code source. Il n'y a **rien à fournir en plus du paquet** : pas de bundler, pas
de minification, pas d'étape de compilation — les fichiers du `.zip` sont les fichiers du dépôt
(voir `docs/developpement.md`). Texte à coller :

> L'extension ne contient aucun code compilé ni minifié : les fichiers du paquet sont les
> sources, telles qu'elles se lisent dans le dépôt. Aucun script distant n'est chargé, aucun
> `eval`. Les polices sont livrées dans le paquet.
>
> Elle nécessite un compte Certimens. Compte de test : e-mail `<à renseigner>`, mot de passe
> `<à renseigner>`. L'adresse du moteur n'est pas à saisir : elle vaut celle par défaut, et vit
> dans les paramètres avancés du formulaire.
>
> 1. Ouvrir un document sur https://docs.google.com/document/ ;
> 2. cliquer sur l'icône de l'extension, se connecter avec le compte ci-dessus ;
> 3. « Créer le document » associe le document ouvert à un document Certimens ;
> 4. écrire quelques phrases : les compteurs partent après 2 secondes sans frappe, et le badge
>    de l'extension affiche `ON`.

## Confidentialité

- URL : `https://certimens.fr/politique-de-confidentialite/`
- La page doit répondre **sans connexion** et nommer l'extension — même exigence que le
  Chrome Web Store (voir [`../chrome/`](../chrome/), qui détaille les deux refus possibles).
