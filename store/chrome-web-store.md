# Chrome Web Store — onglet « Pratiques de confidentialité »

Textes à copier dans le tableau de bord. Chaque justification fait moins de 1 000 caractères.
Ils décrivent ce que fait le code actuel (`extension/`) : à revoir si une autorisation change.

## Objectif unique

> Mesurer la façon dont l'étudiant rédige un document dans Google Docs ou Word Online (rythme de
> frappe, pauses, corrections, collages) et envoyer ces compteurs à son espace Certimens, pour
> que l'enseignant puisse vérifier que le travail rendu a bien été rédigé par l'étudiant. Aucun
> texte saisi ni aucune touche n'est enregistré : seulement des compteurs agrégés.

## Justification de l'autorisation `storage`

> Enregistre localement la configuration de l'extension (adresse du serveur Certimens, e-mail de
> l'étudiant et un jeton d'accès obtenu à la connexion — le mot de passe n'est pas conservé) et le lien entre chaque document
> Google Docs / Word Online et son fichier Certimens. Sert aussi de file d'attente : quand
> l'étudiant est hors ligne ou que le serveur ne répond pas, les mesures (des compteurs, jamais
> de texte) y sont gardées puis envoyées dès que la connexion revient. storage.session retient
> les documents pour lesquels la fenêtre de l'extension s'est déjà ouverte, pour ne pas la
> rouvrir pendant la même session.

## Justification de l'autorisation `alarms`

> Une alarme toutes les minutes relance l'envoi des mesures restées en attente (étudiant hors
> ligne, serveur momentanément indisponible). Le service worker de l'extension pouvant être
> arrêté par Chrome, l'alarme est le seul moyen fiable de réessayer l'envoi sans que l'étudiant
> ait à rouvrir son document. Elle n'affiche aucune notification.

## Justification de l'autorisation d'accès à l'hôte

> - docs.google.com/document/* et *.officeapps.live.com, *.cloud.microsoft (iframe d'édition
>   wordeditorframe.aspx) : le script de contenu y compte l'activité de rédaction dans l'éditeur
>   (nombre de frappes, intervalles entre frappes, pauses, corrections, déplacements, collages).
>   Seule la catégorie de la touche est utilisée (caractère, effacement, flèche…) : ni le texte
>   ni les touches ne sont enregistrés. Il lit aussi le titre et le nombre de caractères du
>   document.
> - docs.google.com et *.googleusercontent.com : export du document (.docx, et texte pour
>   compter les caractères) quand l'étudiant clique sur « Envoyer le .docx ». Google redirige
>   l'export vers googleusercontent.com.
> - monespace.certimens.fr et monespace.certimens.com : serveur Certimens de l'étudiant, qui
>   reçoit les mesures et le document.
> - https://*/* et http://*/* (facultatifs, demandés à l'utilisateur) : uniquement si
>   l'établissement héberge son propre serveur Certimens à une autre adresse.

## Utilisez-vous du code distant ?

**Non, je n'utilise pas de « code distant ».** Tout le JavaScript est inclus dans le paquet :
aucun script externe, aucun `eval`, aucun module chargé à distance. L'extension échange
seulement des données JSON avec le serveur Certimens.

## Utilisation des données (cases à cocher)

Données collectées :

- **Informations d'authentification** : e-mail Certimens de l'étudiant et le jeton d'accès créé
  à la connexion (le mot de passe, saisi une fois, n'est pas conservé).
- **Activité Web** : compteurs de rédaction dans l'éditeur (frappes, pauses, corrections,
  collages, sorties du document).
- **Contenu de sites Web** : le document .docx, envoyé seulement quand l'étudiant clique sur
  « Envoyer le .docx », ainsi que le titre et le nombre de caractères du document.

À certifier : les données ne sont ni vendues, ni utilisées ou transférées à des fins sans
rapport avec l'objectif unique, ni utilisées pour évaluer une solvabilité ou accorder un prêt.

Une **URL de règles de confidentialité** est obligatoire quand des données sont collectées.
Il faut une page publique sur certimens.fr qui reprenne ces trois catégories.

## Coordonnées

L'adresse d'assistance affichée sur la fiche, et l'e-mail de contact à vérifier dans le tableau
de bord (*Compte* › coordonnées du développeur) : **contact@certimens.fr**. C'est la même
adresse pour les autres stores (AMO, Edge, Opera, AppSource).
