# Certimens — Agent de rédaction pour VS Code

Certimens atteste que le code rendu a bien été écrit par l'étudiant qui le rend. L'extension
mesure la **manière** dont chaque fichier du projet est écrit — rythme, pauses, corrections,
navigation, injections — et transmet ces compteurs à l'espace Certimens de l'établissement.

## Ce qui est envoyé

Des **compteurs, et rien d'autre**. Aucune touche, aucun caractère, aucune ligne de code ne quitte
votre poste pendant la mesure : le capteur traduit chaque modification en catégories, puis les
oublie.

Une seule commande envoie votre texte, et seulement quand vous la lancez : **Certimens : rendre ce
fichier**, qui dépose le fichier ouvert sur votre espace et le rattache à un devoir.

## Utilisation

1. **Certimens : se connecter** (palette de commandes) ou le panneau Certimens dans la barre
   d'activité — votre mot de passe est échangé contre un jeton révocable, et n'est jamais conservé.
2. Écrivez. Chaque fichier du projet est mesuré séparément et apparaît comme un document distinct
   sur votre espace, créé dès la première frappe réelle.
3. **Certimens : rendre ce fichier** quand le travail est prêt.

Les dépendances, la sortie de compilation et les fichiers générés ne sont pas mesurés ; la liste
est modifiable par le réglage `certimens.exclude`.

## Ce que cet agent mesure, et ce qu'il ne mesure pas

VS Code ne livre pas les frappes : il signale ce qui change dans le document et d'où vient le
curseur. Toutes les mesures du produit en découlent, **sauf le nombre de collages** : une
insertion faite en un coup peut être un collage, un extrait de code ou une complétion acceptée
d'IntelliSense ou d'un assistant. Les caractères sont comptés comme injection, le nombre de
collages ne l'est pas — il serait faux.

---

Code source, documentation et autres agents (navigateur, Word, LibreOffice) :
<https://github.com/Certimens/plugins>. Questions : contact@certimens.fr
