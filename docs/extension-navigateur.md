# Extension navigateur

Extension **Manifest V3** (`browser/`) qui mesure la rédaction **directement dans Google Docs
et Word Online**, sans agent de bureau : Chrome, Edge, Opera, Brave, Vivaldi, Arc, Firefox,
Firefox pour Android, Safari macOS et iOS. Un seul jeu de sources, un seul manifest ; le build
en tire le paquet de chaque navigateur (voir [developpement.md](developpement.md)).

Les chemins ci-dessous sont relatifs à `browser/src/`, le dossier qui part dans les paquets.

## Fonctionnement

- `content.js` écoute l'éditeur : dans Google Docs, l'iframe de saisie
  (`.docs-texteventtarget-iframe`) et les clics dans le corps du document ; dans Word Online, il
  tourne dans l'iframe d'édition (`wordeditorframe.aspx` sur `*.officeapps.live.com`) et écoute
  la zone `#WACViewPanel`. Ce qui diffère d'un éditeur à l'autre est décrit dans `EDITORS`. Les
  règles de comptage, elles, sont communes aux quatre agents ([mesures.md](mesures.md)).
- `background.js` crée au premier envoi le **document Certimens** du document ouvert
  (`POST /api/documents`, nommé d'après son titre), puis envoie les mesures. Hors-ligne,
  elles restent dans une file
  (`chrome.storage.local`) renvoyée chaque minute. Le badge affiche `ON`, le nombre de mesures en
  attente, `OFF` (non configuré, ou identifiants refusés) ou `II` (mesure suspendue, voir
  [mesures.md](mesures.md)).
- `i18n.js`, `ui.js`, `ui.css` sont partagés avec le complément Word, que le build sert depuis
  une copie ([langues.md](langues.md)).

## La popup

Un clic sur l'icône ouvre la popup : l'étudiant s'y connecte (identifiants vérifiés par
`POST /api/auth/login` avant d'être enregistrés) puis, sur un document, crée son **document
Certimens** (`POST /api/documents`, nom modifiable, pré-rempli avec le titre du document) et
l'ouvre dans le moteur. Elle propose aussi de le rendre sur un devoir auquel l'étudiant est rattaché
(`GET /api/assignments`, puis `PUT /api/documents/:id` avec `assignment_id`) ; ce choix n'apparaît
que pour les comptes au rôle `student` (vérifié par `GET /api/auth/me`).

Elle envoie aussi le **.docx** au document Certimens (`PUT /api/documents/:id`, base64, 18 Mo
au plus) : dans Google Docs en un clic (export `format=docx` avec la session de l'étudiant) ;
dans Word Online, l'iframe d'édition n'a pas accès au fichier, l'étudiant choisit donc une copie
téléchargée (*Fichier › Enregistrer sous › Télécharger une copie*). Un nouvel envoi remplace le
document précédent.

Un document **renommé dans l'éditeur** (titre relevé toutes les 3 s) est renommé côté moteur
(`PUT /api/documents/:id` avec `name`), y compris s'il a été renommé hors-ligne : le
renommage part au prochain envoi. Un nom choisi dans la popup est conservé tant que le titre du
document ne change pas.

Quand l'étudiant est connecté et ouvre un document encore inconnu de l'extension, la popup
s'ouvre d'elle-même (une fois par document et par session de navigateur, Chrome 127+) ; si le
navigateur le refuse (Firefox), l'icône de l'onglet affiche `NEW`. Sans création explicite, le
document Certimens est créé au premier envoi de mesures.

La page d'options s'ouvre à l'installation : adresse du moteur (par défaut
`https://monespace.certimens.fr`), e-mail et mot de passe de l'étudiant.

## Word Online

- Le document est identifié par le paramètre `WOPISrc` de l'iframe d'édition (stable d'une
  ouverture à l'autre), son nom par le titre affiché dans Word.
- `real_volume` est lu dans la page (texte de `#WACViewPanel_EditingElement`), sans export.
- `focus_losses` ne compte que le masquage de la page (autre onglet, navigateur réduit) : un clic
  dans l'en-tête Microsoft 365 fait perdre le focus à l'iframe sans quitter le document. Passer à
  une autre fenêtre ferme quand même la fenêtre de mesure.
- Les sélecteurs de Word Online ne sont pas documentés par Microsoft : à revérifier si la mesure
  s'arrête après une mise à jour de Word.

> Sur Word pour le web, ne pas utiliser l'extension en même temps que le complément Word : la
> rédaction serait comptée deux fois (le volet le rappelle).
>
> Ne pas l'utiliser non plus en même temps que l'agent de bureau + Web Shield (`legacy/`) sur
> Google Docs, pour la même raison.

## Mode debug

La page d'options a une case **Mode debug**. Activée, elle :

- journalise dans la console du document chaque suppression et la case dans laquelle elle tombe
  (correction immédiate, reformulation différée, révision massive), les collages, les sorties du
  document et chaque fenêtre envoyée ;
- garde les 30 dernières fenêtres de mesure dans la page d'options (heure, raison de l'envoi,
  compteurs non nuls), à comparer avec ce qu'affiche le moteur.

Des compteurs uniquement : ni texte ni touches n'y apparaissent, la promesse de l'extension
reste la même. L'état « mesures étendues refusées par le moteur » est affiché dans la section
*Synchronisation*.

## Installer en développement

- **Chrome / Edge** : `chrome://extensions` → mode développeur → *Charger l'extension non
  empaquetée* → le dossier `browser/`.
- **Firefox** : `about:debugging` → *Charger un module temporaire* → `browser/src/manifest.json`.
- **Opera, Brave, Vivaldi, Arc** : comme Chrome (`opera://extensions`, `brave://extensions`…).
- **Safari** (macOS, Xcode) : `make build && make -C browser safari`, ouvrir le projet
  `browser/dist/safari-xcode/Certimens/Certimens.xcodeproj`, lancer le schéma *Certimens (macOS)*, puis
  dans Safari : *Réglages › Développement › Autoriser les extensions non signées* et activer
  l'extension dans *Réglages › Extensions*. Le schéma *Certimens (iOS)* la lance sur iPhone et
  iPad.

Pour un moteur local, saisir `http://localhost:8080` comme adresse du moteur : l'extension
demande alors l'accès à cet hôte (`optional_host_permissions`).
