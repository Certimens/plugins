# Chrome Web Store — onglet « Pratiques de confidentialité »

Textes à copier dans le tableau de bord. Chaque justification fait moins de 1 000 caractères.
Ils décrivent ce que fait le code actuel de l'agent : à revoir si une autorisation change.
Paquet : `dist/chrome.zip`, construit par `make build`.

L'extension est livrée en **français et en anglais** : le nom et la description viennent de
`src/_locales/{fr,en}/messages.json`, et le Chrome Web Store affiche à l'étudiant celle de
sa langue. Les fiches de boutique se remplissent donc dans les deux langues (*Store listing* a un
onglet par langue), à partir de ces messages et des textes ci-dessous — dont la traduction reste
à faire dans le tableau de bord, le store ne la déduit pas du paquet.

## Objectif unique

> Mesurer la façon dont l'étudiant rédige un document dans Google Docs, Word Online ou Overleaf (rythme de
> frappe, pauses, corrections, collages) et envoyer ces compteurs à son espace Certimens, pour
> que l'enseignant puisse vérifier que le travail rendu a bien été rédigé par l'étudiant. Aucun
> texte saisi ni aucune touche n'est enregistré : seulement des compteurs agrégés.

## Justification de l'autorisation `storage`

> Enregistre localement la configuration de l'extension (adresse du serveur Certimens, e-mail
> de l'étudiant et un jeton d'accès obtenu par appairage — aucun mot de passe n'est demandé ni
> conservé) et le lien entre chaque document Google Docs / Word Online / Overleaf et son document
> Certimens. Pendant une connexion, le code court affiché et le code d'appareil qui l'accompagne
> y attendent d'être confirmés, puis sont effacés. Sert aussi de file d'attente : quand
> l'étudiant est hors ligne ou que le serveur ne répond pas, les mesures (des compteurs, jamais
> de texte) y sont gardées puis envoyées dès que la connexion revient. Une clé retient aussi que
> l'étudiant a suspendu la mesure depuis la fenêtre de l'extension, pour que la suspension
> s'applique à tous ses documents et survive au redémarrage du navigateur. storage.session retient
> les documents pour lesquels la fenêtre de l'extension s'est déjà ouverte, pour ne pas la
> rouvrir pendant la même session.

## Justification de l'autorisation `alarms`

> Une alarme toutes les minutes relance l'envoi des mesures restées en attente (étudiant hors
> ligne, serveur momentanément indisponible) et termine une connexion en cours, une fois que
> l'étudiant a confirmé son code. Le service worker de l'extension pouvant être arrêté par
> Chrome, l'alarme est le seul moyen fiable de reprendre l'un comme l'autre sans que l'étudiant
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
> - *.overleaf.com (pages /project/*) : le script de contenu y compte la même activité de
>   rédaction dans l'éditeur du projet. Il ne lit ni les sources LaTeX ni le PDF : seulement
>   l'id du projet dans l'URL et son titre affiché.
> - monespace.certimens.fr et monespace.certimens.com : serveur Certimens de l'étudiant, qui
>   reçoit les mesures et le document.
> - https://*/* et http://*/* (facultatifs, **jamais demandés à l'installation**) : demandés un
>   par un, pour une adresse que l'utilisateur saisit lui-même dans la page d'options, dans deux
>   cas et deux seulement — l'établissement héberge son propre serveur Certimens à une autre
>   adresse, ou l'étudiant rédige son devoir sur un site que l'extension ne connaît pas (le
>   Moodle de son établissement, un Canvas, un wiki) — dans ce second cas, le plus souvent en
>   ouvrant la fenêtre de l'extension sur la page concernée et en cliquant « Mesurer cette page ».
>   L'autorisation porte alors sur cette seule adresse ; elle se retire depuis la page d'options,
>   qui la rend au navigateur. Sur ces sites,
>   l'extension compte la même activité de rédaction qu'ailleurs : ni le contenu saisi, ni les
>   autres pages visitées, ni aucun identifiant.

## Justification de l'autorisation `activeTab`

> Sert à une seule chose : quand l'utilisateur ouvre la fenêtre de l'extension sur une page où
> aucun éditeur connu n'a été trouvé, elle lit l'adresse de cet onglet pour pouvoir proposer
> « Mesurer cette page » et demander l'autorisation portant sur cette seule adresse. L'adresse
> n'est lue qu'à ce moment-là — ouvrir la fenêtre de l'extension est le geste qu'activeTab
> demande — et elle n'est ni conservée ni envoyée tant que l'utilisateur n'a pas accepté.

## Justification de l'autorisation `scripting`

> Enregistre le script de mesure sur les adresses que l'utilisateur a lui-même ajoutées dans la
> page d'options, et seulement sur celles-là (chrome.scripting.registerContentScripts). Chaque
> établissement a son propre Moodle ou son propre Canvas : ces adresses ne peuvent pas figurer
> dans le manifest, et les demander toutes à l'installation reviendrait à demander l'accès au web
> entier. L'extension n'injecte aucun code dans une page sans que l'utilisateur ait saisi son
> adresse et accordé l'autorisation correspondante ; retirer l'adresse retire le script et rend
> l'autorisation. Aucun code n'est téléchargé : le script enregistré est celui du paquet
> (content.js).
>
> L'établissement de l'utilisateur peut **suggérer** ces adresses (son Moodle, son Canvas), ce
> qui lui évite de les saisir. Une suggestion n'accorde rien : elle s'affiche dans la page
> d'options, et c'est le clic de l'utilisateur sur cette page qui déclenche
> chrome.permissions.request pour cette seule origine. Le script injecté reste celui du paquet —
> seules les adresses où il peut l'être changent, et uniquement avec l'accord de l'utilisateur.

## Utilisez-vous du code distant ?

**Non, je n'utilise pas de « code distant ».** Tout le JavaScript est inclus dans le paquet :
aucun script externe, aucun `eval`, aucun module chargé à distance. L'extension échange
seulement des données JSON avec le serveur Certimens.

## Utilisation des données (cases à cocher)

Données collectées :

- **Informations d'authentification** : e-mail Certimens de l'étudiant et le jeton d'accès remis
  à l'appairage (aucun mot de passe n'est demandé ni conservé).
- **Activité Web** : compteurs de rédaction dans l'éditeur (frappes, pauses, corrections,
  collages, sorties du document).
- **Contenu de sites Web** : le document rendu, envoyé seulement sur une action explicite de
  l'étudiant — le .docx quand il clique sur « Envoyer le .docx », ou, sur un site qu'il a
  lui-même ajouté (son Moodle, son Canvas), le texte qu'il a écrit dans la zone de rédaction
  quand il clique sur « Envoyer le texte de cette page ». Rien n'est envoyé sans ce clic. Ainsi
  que le titre et le nombre de caractères du document.

À certifier : les données ne sont ni vendues, ni utilisées ou transférées à des fins sans
rapport avec l'objectif unique, ni utilisées pour évaluer une solvabilité ou accorder un prêt.

Une **URL de règles de confidentialité** est obligatoire quand des données sont collectées, et
c'est sur ce point que la fiche a déjà été refusée (motif *Purple Nickel*). À déclarer :

> https://certimens.fr/politique-de-confidentialite/

C'est la page du dépôt `Certimens/website`, qui couvre les trois catégories ci-dessus, nomme les
agents un par un et décrit les durées de conservation réelles. Deux conditions pour qu'elle passe
la revue :

- **elle doit répondre publiquement à cette URL**, sans connexion. La page `/privacy` de l'espace
  Certimens ne convient pas : c'est une application React, et un examinateur qui n'exécute pas le
  JavaScript n'y voit qu'une page vide ;
- **elle doit parler de l'extension**, pas seulement du site. L'ancienne politique WordPress
  (`/index.php/elementor-515/`) ne mentionne aucune extension : la déclarer, c'est le refus.

## Visuels

- Capture : [`screenshot-1280x800.png`](screenshot-1280x800.png), régénérée par
  `scripts/brand-assets.mjs`.
- Icônes : celles du paquet (`icons/`) suffisent.

## Coordonnées

L'adresse d'assistance affichée sur la fiche, et l'e-mail de contact à vérifier dans le tableau
de bord (*Compte* › coordonnées du développeur) : **contact@certimens.fr**. C'est la même
adresse pour les autres boutiques ([`../`](../), et celles des trois autres agents).
