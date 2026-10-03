# Certimens — Agent de rédaction pour VS Code

Certimens atteste que le code rendu a bien été écrit par l'étudiant qui le rend. L'extension
mesure la **manière** dont chaque fichier du projet est écrit — rythme, pauses, corrections,
navigation, injections — et transmet ces compteurs à l'espace Certimens de l'établissement.

## Ce qui est envoyé

Des **compteurs, et rien d'autre**. Aucune touche, aucun caractère, aucune ligne de code ne quitte
votre poste pendant la mesure : le capteur traduit chaque modification en catégories, puis les
oublie.

L'extension compte aussi ce qui lui arrive à **elle** — installation, mise à jour, démarrage, ses
propres erreurs, les envois qui n'ont pas abouti — et envoie ces nombres à l'espace Certimens au
plus toutes les quinze minutes, une fois connectée. Ce sont des compteurs techniques et rien
d'autre : ni message d'erreur, ni nom de fichier, ni contenu, et l'espace les additionne par
version de l'extension sans les conserver avec votre compte ni avec votre établissement.

Une seule commande envoie votre texte, et seulement quand vous la lancez : **Certimens : rendre ce
fichier**, qui dépose le fichier ouvert sur votre espace et le rattache à un devoir.

## Utilisation

1. **Certimens : se connecter** (palette de commandes) ou le panneau Certimens dans la barre
   d'activité — **aucun mot de passe ne vous est demandé** : l'extension affiche un code court,
   vous le confirmez dans votre espace Certimens, et elle reçoit un jeton révocable.
2. Écrivez. Chaque fichier du projet est mesuré séparément et apparaît comme un document distinct
   sur votre espace, créé dès la première frappe réelle.
3. **Certimens : rendre ce fichier** quand le travail est prêt.

Les dépendances, la sortie de compilation et les fichiers générés ne sont pas mesurés ; la liste
est modifiable par le réglage `certimens.exclude`.

Un souci ? **Certimens : signaler un problème** (palette), le lien au pied du panneau ou le bouton
des notifications d'erreur ouvrent, dans votre navigateur, le formulaire d'aide de votre espace
Certimens. Il est prérempli d'un court état technique — version, éditeur, système, état de la
connexion, nombre de mesures en attente —, sans jeton, sans adresse e-mail, sans nom de fichier
ni contenu ; vous le lisez en entier et pouvez le retirer avant d'envoyer.

## Ce que cet agent mesure, et ce qu'il ne mesure pas

VS Code ne livre pas les frappes : il signale ce qui change dans le document et d'où vient le
curseur. Toutes les mesures du produit en découlent.

Un bloc qui arrive d'un coup peut être un collage ou une suggestion acceptée — une complétion
d'IntelliSense, la proposition d'un assistant, un extrait de code. Depuis **VS Code 1.97**,
l'éditeur prévient l'extension de chaque collage et de chaque glisser-déposer avant de
l'appliquer, sans qu'elle lise ce qui est collé : un bloc annoncé est compté comme un collage,
un bloc qui ne l'a pas été comme une **suggestion acceptée**, qui n'est ni une frappe ni un
collage. Sur une version plus ancienne, dans un navigateur, avec un mode Vim ou Neovim, ou le
réglage `editor.pasteAs.enabled` désactivé, l'extension ne peut pas faire la différence : tout
bloc y est compté comme un collage.

---

Code source, documentation et autres agents (navigateur, Word, LibreOffice) :
<https://github.com/Certimens/plugins>. Questions : contact@certimens.fr
