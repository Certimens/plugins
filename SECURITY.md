# Signaler une vulnérabilité

Ce dépôt contient quatre agents installés sur le poste d'un étudiant, qui détiennent un **jeton
d'API** sans expiration et observent la rédaction d'un document. Un défaut y a des conséquences
qui ne se rattrapent pas par une mise à jour de serveur : les paquets sont distribués par des
boutiques, et un étudiant met des semaines à les mettre à jour.

## Où signaler

- **De préférence** : *Security* › *Report a vulnerability* sur ce dépôt (signalement privé
  GitHub). Le rapport reste invisible jusqu'au correctif.
- **Sinon** : **contact@certimens.fr**, en écrivant « sécurité » dans l'objet.

Merci de laisser **90 jours** avant toute divulgation publique, et de ne pas ouvrir d'issue
publique : une issue décrit la faille à tous ceux qui ont déjà l'agent installé.

Nous accusons réception sous **5 jours ouvrés** et disons, dans le même message, si le
signalement est retenu et sous quel délai. Il n'y a pas de programme de prime.

## Ce qui est couvert

Les quatre agents de ce dépôt : extension navigateur, complément Word, extension LibreOffice,
extension VS Code — et leur chaîne de publication (les workflows de `.github/`, qui portent les
identifiants des boutiques).

Le **moteur** qui reçoit les mesures est développé séparément et n'est pas dans ce dépôt. Un
signalement qui le concerne lui est transmis : écrivez à la même adresse, il n'y a pas d'autre
démarche à faire.

## Ce qui nous intéresse en premier

Par ordre de gravité, les quatre promesses que ces agents tiennent et qu'une faille casserait :

1. **Aucun texte de l'étudiant ne quitte son poste**, hors dépôt explicite de document. Tout
   chemin par lequel du contenu, une touche ou une empreinte lisible partirait vers le moteur,
   un journal ou un tiers.
2. **Le jeton d'API ne fuit pas.** Il est conservé dans `chrome.storage.local`, le `localStorage`
   du volet Office, `certimens.json` et le **SecretStorage** de VS Code. Tout chemin qui
   l'exposerait à une page, à un fichier synchronisé (`settings.json`), à un journal ou à une
   webview nous intéresse. Il n'expire pas : un jeton qui fuit est un jeton gardé, et c'est ce
   qui fait de ce point le second et non le dernier.

   Deux limites que nous connaissons et qu'il est inutile de nous signaler : le volet Word est
   servi sur une origine GitHub Pages **partagée avec les autres dépôts du même compte**, et il
   est le seul agent dont la fenêtre n'a pas de Content Security Policy. Les deux sont inscrites
   dans [`word/TESTING.md`](word/TESTING.md), avec ce qu'il faut faire et pourquoi ce n'est pas
   encore fait. En revanche, **tout autre chemin vers ce `localStorage` nous intéresse.**
3. **Aucun code distant.** Les agents n'embarquent que leur propre code ; tout ce qui
   ressemblerait à un chargement de script, à un `eval` ou à une dépendance d'exécution
   inattendue est un défaut, y compris dans un paquet publié.
4. **La suspension est réelle.** Un agent qui mesurerait en se disant suspendu, ou qui
   reprendrait tout seul, trompe l'étudiant sur ce qui est observé.

## Ce qui n'en est pas une

- **Rejouer ce qu'envoie un agent.** Les agents sont livrés en clair : tout ce qu'ils présentent
  au moteur, un tiers peut le recopier. Ce n'est pas un secret, c'est un aveu assumé — ce que
  présente un agent sert à rendre une contrefaçon *visible*, pas à prouver son identité, et le
  moteur signale un envoi qui ne ressemble à aucun agent connu.
- **Un jeton d'API sans expiration.** C'est un choix : un agent travaille sans surveillance. Il
  est révocable depuis l'espace Certimens et par l'agent lui-même à la déconnexion.
- **Contourner la mesure** (écrire ailleurs, suspendre, désinstaller). La mesure n'est pas une
  surveillance qu'on cherche à rendre inéluctable : un trou reste lisible côté moteur, dans la
  part du document qu'aucune mesure n'explique.
