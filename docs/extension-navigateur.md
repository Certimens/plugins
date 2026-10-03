# Extension navigateur

Extension **Manifest V3** (`browser/`) qui mesure la rédaction **directement dans Google Docs,
Word Online et Overleaf**, sans agent de bureau : Chrome, Edge, Opera, Brave, Vivaldi, Arc, Firefox,
Firefox pour Android, Safari macOS et iOS. Un seul jeu de sources, un seul manifest ; le build
en tire le paquet de chaque navigateur (voir [developpement.md](developpement.md)).

Les chemins ci-dessous sont relatifs à `browser/src/`, le dossier qui part dans les paquets.

## Fonctionnement

- `content.js` écoute l'éditeur : dans Google Docs, l'iframe de saisie
  (`.docs-texteventtarget-iframe`) et les clics dans le corps du document ; dans Word Online, il
  tourne dans l'iframe d'édition (`wordeditorframe.aspx` sur `*.officeapps.live.com`) et écoute
  la zone `#WACViewPanel` ; dans Overleaf, la zone CodeMirror `.cm-editor` de
  `overleaf.com/project/…`. Ce qui diffère d'un éditeur à l'autre est décrit dans `EDITORS` —
  **un éditeur s'ajoute là, et nulle part ailleurs**. Les règles de comptage, elles, sont
  communes aux quatre agents ([mesures.md](mesures.md)).
  Le script tourne dans un monde isolé mais pose ses écouteurs sur **le même `document` et la
  même `window` que la page** : celle-ci peut donc émettre ces évènements elle-même, et un
  évènement construit porte `isTrusted` à faux. Toute inscription passe par un unique
  enregistreur qui refuse ce qui ne vient pas de l'agent utilisateur — un écouteur ajouté demain
  ne peut pas devenir l'exception. Les quatre écouteurs de cycle de vie (visibilité, focus,
  perte de focus, départ de page) ne testaient pas ce drapeau : une page mesurée pouvait faire
  monter `focus_losses` à un nombre de son choix, sous le jeton de l'étudiant.
- `background.js` crée au premier envoi le **document Certimens** du document ouvert
  (`POST /api/documents`, nommé d'après son titre), puis envoie les mesures. Hors-ligne,
  elles restent dans une file
  (`chrome.storage.local`) renvoyée chaque minute. Le badge affiche `ON`, le nombre de mesures en
  attente, `OFF` (non configuré, ou accès refusé par le moteur) ou `II` (mesure suspendue, voir
  [mesures.md](mesures.md)).
- `i18n.js`, `ui.js`, `ui.css` sont partagés avec le complément Word, que le build sert depuis
  une copie ([langues.md](langues.md)).
- **Quatre portées, quatre fichiers partagés**, parce que le service worker, les deux pages et le
  volet Word ne chargent pas le même code :

  | Fichier | Chargé par | Ce qu'il porte |
  | --- | --- | --- |
  | `constants.js` | le worker **et** les pages | l'adresse du moteur par défaut, les hôtes de l'export Google Docs, la règle disant quelle adresse de moteur est acceptable |
  | `i18n.js` | le worker, les pages, le volet Word | le dictionnaire ([langues.md](langues.md)) |
  | `ui.js` | les pages **et** le volet Word | l'en-tête, les messages, le sélecteur de devoirs |
  | `pages.js` | les deux pages seules | ce qui atteint `chrome.*` : la langue de la page, la demande d'accès au moteur |

  La règle qui tient l'ensemble : **rien de ce que charge le volet Word ne touche à `chrome.*`**,
  et rien n'est déclaré deux fois. Une valeur écrite dans le worker *et* dans une page divergeait
  sans que rien ne le dise — la popup demandant une permission que le worker n'utilise pas — et
  une fonction d'`ui.js` qui appelait `chrome.permissions` était du code mort livré dans le
  volet Word.

## La popup

Un clic sur l'icône ouvre la popup : l'étudiant y appaire l'agent (un code court confirmé dans son
espace Certimens, voir [moteur.md](moteur.md#adresse-et-authentification)) puis, sur un document,
crée son **document Certimens** (`POST /api/documents`, nom modifiable, pré-rempli avec le titre du
document) et l'ouvre dans le moteur. Elle propose aussi de le rendre sur un devoir auquel l'étudiant
est rattaché (`GET /api/assignments`, puis `PUT /api/documents/:id` avec `assignment_id`) ; ce choix
n'apparaît que pour les comptes au rôle `student` (vérifié par `GET /api/auth/me`).

Elle envoie aussi le **.docx** au document Certimens (`PUT /api/documents/:id`, base64, 18 Mo
au plus) : dans Google Docs en un clic (export `format=docx` avec la session de l'étudiant) ;
dans Word Online, l'iframe d'édition n'a pas accès au fichier, l'étudiant choisit donc une copie
téléchargée (*Fichier › Enregistrer sous › Télécharger une copie*). Un nouvel envoi remplace le
document précédent.

Un devoir dont l'**échéance est passée** reste listé mais n'est plus choisissable, et quand
c'est celle du devoir de la copie (`assignment_deadline`), la popup retire le choix du devoir,
le bouton de rendu et l'envoi du .docx, et dit pourquoi : le moteur les refuserait tous les
trois, la mesure continue, et tout rouvre si l'enseignant repousse l'échéance
([moteur.md](moteur.md)).

Un document **renommé dans l'éditeur** (titre relevé toutes les 3 s) est renommé côté moteur
(`PUT /api/documents/:id` avec `name`), y compris s'il a été renommé hors-ligne : le
renommage part au prochain envoi. Un nom choisi dans la popup est conservé tant que le titre du
document ne change pas.

Quand l'étudiant est connecté et ouvre un document encore inconnu de l'extension, la popup
s'ouvre d'elle-même (une fois par document et par session de navigateur, Chrome 127+) ; si le
navigateur le refuse (Firefox), l'icône de l'onglet affiche `NEW`. Sans création explicite, le
document Certimens est créé au premier envoi de mesures.

La page d'options s'ouvre à l'installation. Elle ne demande **aucun mot de passe** : le bouton
**Se connecter** obtient un code court auprès du moteur, l'étudiant le saisit dans son espace
Certimens, et l'extension reçoit un jeton d'API — le flux est décrit dans
[moteur.md](moteur.md#adresse-et-authentification). L'adresse du moteur reste repliée dans les
**paramètres avancés** (par défaut `https://monespace.certimens.fr`), et ce qu'elle a le droit
d'être est une règle à part : `https:` partout, `http:` seulement vers un hôte qui ne sort pas
du bâtiment ([moteur.md](moteur.md#ce-que-cette-adresse-a-le-droit-dêtre)). La page la refuse au
moment de la validation, avant même de demander la permission d'hôte au navigateur ; le worker
la refuse à chaque appel, ce qui couvre l'alarme qui termine un appairage et une file qui part
vers une adresse enregistrée avant que la règle existe.

L'attente se passe dans le **service worker**, pas dans la popup : celle-ci se ferme dès que
l'étudiant change d'onglet pour confirmer le code, et une attente qui mourrait avec elle
n'aboutirait jamais. Rouvrir la popup reprend l'appairage là où il en est, et la page d'options
— qui, elle, est un onglet qui reste ouvert — le reprend quand elle **redevient visible** ;
sinon, la même alarme d'une minute que la file d'attente le termine.

La **déconnexion** est offerte aux deux endroits : en icône dans la popup, en bouton texte sur la
page d'options, qui dit quel compte est connecté. Elle reste offerte quand le moteur refuse le
jeton (révoqué depuis l'espace Certimens, par exemple) : la popup n'affiche alors plus le compte,
mais garde cette icône — c'est le seul moyen de solder la session, un nouvel appairage écrivant
un second jeton par-dessus un premier que personne n'a révoqué. La suspension, elle, disparaît
dans cet état : son bandeau n'est pas à l'écran, et sa couleur resterait seule à porter l'état.

## Word Online

- Le document est identifié par le paramètre `WOPISrc` de l'iframe d'édition (stable d'une
  ouverture à l'autre), son nom par le titre affiché dans Word.
- `real_volume_chars` est lu dans la page (texte de `#WACViewPanel_EditingElement`), sans export.
- `focus_losses` ne compte que le masquage de la page (autre onglet, navigateur réduit) : un clic
  dans l'en-tête Microsoft 365 fait perdre le focus à l'iframe sans quitter le document. Passer à
  une autre fenêtre ferme quand même la fenêtre de mesure.
- Les sélecteurs de Word Online ne sont pas documentés par Microsoft : à revérifier si la mesure
  s'arrête après une mise à jour de Word. Cinq secondes après le chargement, le capteur
  vérifie que la zone d'édition de l'éditeur existe dans la page et **l'écrit dans la console**
  si elle est absente : une refonte qui la renomme fait sinon tout jeter en silence.

> Sur Word pour le web, ne pas utiliser l'extension en même temps que le complément Word : la
> rédaction serait comptée deux fois (le volet le rappelle).
>
> Ne pas l'utiliser non plus en même temps que l'agent de bureau + Web Shield (`legacy/`) sur
> Google Docs, pour la même raison.

## Overleaf

- Le document est le **projet**, identifié par son id dans l'URL (`overleaf.com/project/<id>`),
  son nom par le titre du projet. Un projet contient plusieurs `.tex`, mais c'est un mémoire que
  l'étudiant écrit, pas un fichier — et l'éditeur passe de l'un à l'autre sans recharger la page.
- La zone d'édition est `.cm-editor` (CodeMirror 6) : un `contenteditable`, pas une iframe.
- **Pas de `real_volume_chars`**, et c'est délibéré : CodeMirror ne rend que les lignes visibles, donc
  compter les caractères présents dans la page donnerait une fraction du document, qui bougerait
  avec l'ascenseur. Le moteur distingue l'absence d'une mesure de la valeur zéro
  ([mesures.md](mesures.md)) ; une mesure fausse, lui, le tromperait.
- Pas d'export non plus : les sources ne sont pas joignables depuis la page, l'étudiant dépose
  donc une copie téléchargée, comme dans Word Online.
- Seul `overleaf.com` est couvert. Une instance auto-hébergée par un établissement a son propre
  domaine, qu'aucun manifest ne peut deviner.

## Les sites que l'étudiant ajoute lui-même

Trois éditeurs sont dans le manifest. Le quatrième n'y sera jamais : **chaque établissement a
son propre Moodle**, son propre Canvas, son propre wiki, et aucune liste ne les nommera tous.
Demander `https://*/*` à l'installation pour les couvrir reviendrait à demander le web entier à
tous les étudiants pour en servir quelques-uns — et c'est exactement ce que les boutiques
regardent de près.

Le site se déclare donc **après**, par l'étudiant, et de trois façons — la même mécanique
derrière, trois moments différents :

**Depuis la page, en un clic.** C'est le chemin normal : l'étudiant est sur son Moodle, il ouvre
la fenêtre de l'extension, qui ne reconnaît aucun éditeur et propose *Mesurer cette page*. Un
clic, le navigateur demande l'autorisation pour **cette origine seule**, et la mesure démarre —
le script est injecté dans l'onglet ouvert (`chrome.scripting.executeScript`), sans recharger la
page que l'étudiant est en train d'écrire. Rien n'est déclaré à l'avance, et rien n'est demandé
pour un site qu'il n'a pas nommé.

L'adresse de l'onglet vient d'**`activeTab`**, qui ne la donne qu'une fois la fenêtre de
l'extension ouverte : l'ouvrir *est* le geste. C'est aussi pour ce geste que la demande se fait
là et non dans le service worker — `chrome.permissions.request` l'exige.

**Depuis la page d'options.** La même adresse peut s'ajouter à la main, et c'est surtout là que
la **liste** des sites ajoutés se relit et se retire. *Retirer* désenregistre le script **et**
rend l'autorisation au navigateur.

**Parmi ce que l'établissement propose.** L'établissement dit au moteur où ses étudiants
rédigent, et l'extension lit cette liste (`writing_sites` de `GET /api/auth/me`, voir
[moteur.md](moteur.md)) pour la
présenter dans la page d'options, au-dessus de l'ajout manuel. Elle ne la remplace pas : un
étudiant qui rédige ailleurs ajoute toujours son adresse lui-même.

Cette troisième source **propose** et n'accorde rien, et c'est une contrainte avant d'être une
intention : `chrome.permissions.request` n'obéit qu'à un geste de l'utilisateur, qu'aucun serveur
n'aura jamais. Le moteur ne peut donc pas accorder un accès, seulement en suggérer un. D'où la
forme de la carte : **un bouton par adresse**, jamais un « tout autoriser » — ce que le
navigateur affiche ensuite nomme l'origine dont il s'agit, et c'est le seul moment où l'étudiant
est vraiment interrogé. Une proposition refusée reste simplement sur la page.

L'extension n'en retient que ce qu'elle peut réellement demander : `https` et une origine exacte.
Une entrée à joker, en `http` ou d'un autre schéma est écartée sans un mot — la liste vient d'un
serveur, et l'étudiant ne lirait pas ça dans la fenêtre d'autorisation de son navigateur. Un
moteur qui ne connaît pas la route ne propose rien, en silence, et une lecture qui échoue garde
ce que l'établissement proposait la veille (`browser/tests/background.test.mjs`).

Dans les deux cas, le service worker enregistre le script de contenu pour cette origine
(`chrome.scripting.registerContentScripts`, `persistAcrossSessions`).

> **Pourquoi pas « mesurer partout » ?** Demander `https://*/*` une fois et poser le capteur sur
> toutes les pages serait plus simple, et ce serait le mauvais marché : une fenêtre de mesure
> s'ouvrirait dans une webmail, un forum privé, la messagerie d'une banque — et chacune créerait
> son document côté moteur. « Seulement des compteurs » est une promesse sur ce qui **sort** du
> poste, pas une licence pour regarder tout ce qui s'y passe. Le coût est un clic par site ; il
> est payé une fois.

La fenêtre de l'extension ne propose rien là où il n'y a rien à proposer : une page interne du
navigateur, un éditeur déjà connu, un site déjà ajouté, ou un navigateur trop ancien pour
l'enregistrement dynamique — prendre l'autorisation pour ne rien mesurer ensuite serait pire que
de ne rien proposer (`browser/tests/popup.test.mjs`).

`syncSiteScripts()` réconcilie à chaque démarrage, à chaque installation et à chaque changement
de la clé `sites` : un enregistrement survit au redémarrage mais pas à une mise à jour de
l'extension, et retirer un site depuis la page d'options écrit cette clé avant de révoquer la
permission, donc n'y laisse pas de script derrière lui.

Une autorisation révoquée **depuis les réglages du navigateur** n'écrit aucune de ces clés et
l'extension n'écoute pas les évènements de permission : l'enregistrement reste donc en place
jusqu'au prochain démarrage du navigateur. Ce que le navigateur fait alors d'un script enregistré
sous une permission qui n'existe plus — réévaluer à l'injection, ou injecter quand même — n'est
pas tranché ici et dépend du navigateur ; ce qui est sûr, c'est que rien dans l'extension ne le
rattrape en cours de session. Retirer le site depuis la page d'options, lui, réconcilie tout de
suite.

Côté capteur, c'est l'entrée `EDITORS.site`, et rien d'autre :

- le **document est la page**, identifiée par `hostname + pathname + search` — c'est dans la
  requête qu'un Moodle nomme le devoir. Cet identifiant ne quitte pas le poste (seul le titre
  part) ; en revanche, une adresse qui change d'une session à l'autre donne un second document.
- la **zone de saisie** est celle qu'une page utilise pour prendre du texte (`textarea`,
  `contenteditable`, et les corps de ProseMirror, Quill, CodeMirror) : une frappe ailleurs — une
  recherche, un menu — n'est pas de la rédaction ;
- les éditeurs riches de Moodle et de Canvas (TinyMCE, CKEditor) mettent leur corps dans une
  **iframe de même origine**, à laquelle le capteur s'attache. Elles sont nommées, et non prises
  toutes : `iframe` tout court attacherait ce capteur à chaque publicité d'une page quelconque ;
- `real_volume_chars` est lu dans la zone la plus longue de la page — rien n'y est virtualisé,
  contrairement à Overleaf. Une page sans zone de saisie n'envoie **pas** un volume nul.

### Rendre la copie depuis une page

Sur un Moodle, le devoir « texte en ligne » **n'est pas un fichier** : il n'y a rien à choisir
sur le disque. La copie est dans la page, et c'est elle que l'étudiant envoie — *Envoyer le
texte de cette page*, au même endroit que l'export .docx des autres éditeurs.

C'est l'entrée d'`EDITORS` qui dit comment une copie se rend, et la popup n'en sait rien de plus :

| Éditeur | `deposit` | Ce que l'étudiant voit |
| --- | --- | --- |
| Google Docs | `export` | *Envoyer le .docx* — l'extension l'exporte elle-même |
| Word Online | `pick` | *Choisir le .docx téléchargé* — l'iframe n'a pas accès au fichier |
| Overleaf | `pick` | idem — les sources ne sont pas joignables depuis la page |
| Site ajouté | `text` | *Envoyer le texte de cette page* |

Un éditeur qui ne déclare rien retombe sur `pick` : le repli ne doit **jamais** être l'envoi du
texte de la page, qui ferait sortir du contenu d'un éditeur qui n'a rien demandé.

L'envoi est explicite, comme les deux autres : le texte est demandé à la page **au moment du
clic**, jamais avant, et il ne transite par aucune fenêtre de mesure.

### Reconnaître la plateforme

Une page ajoutée peut être un Moodle ou un Canvas, et le capteur les reconnaît — à la route que
Moodle écrit dans la classe du corps de page (`path-mod-…`) ou à sa balise `generator`, à la
coquille `ic-app` de Canvas. Ça ne sert qu'à **affiner**, deux fois :

- le **nom du document** devient le titre du devoir, au lieu de « Devoir : Dissertation | Mon
  établissement » ;
- la **zone de rédaction** devient le champ du devoir (`#id_onlinetext_editoreditable`) plutôt
  que la plus longue de la page — un long message de forum plus bas battrait la copie.

La popup dit laquelle a été reconnue, juste au-dessus du bouton : « c'est bien cette page-là »
est ce que l'étudiant doit lire **avant** d'appuyer sur un bouton qui envoie ce qu'il a écrit.

Une empreinte se périme : rien n'est conditionné à elle. Une page que personne ne reconnaît garde
le comportement générique, et le capteur y marche exactement pareil.

Ce mode est, par construction, le moins sûr des quatre : une page inconnue peut porter son
éditeur autrement. Il vaut mieux qu'un étudiant qui rédige dans son Moodle ne soit pas mesuré du
tout, mais c'est un filet, pas un éditeur pris en charge.

## « Certimens a été mis à jour »

La boutique installe une version nouvelle **sans rien dire** : l'étudiant retrouve un bouton
déplacé et n'a nulle part où aller voir. La popup et la page d'options disent donc une fois, en
une ligne, quelle version tourne, avec un lien vers les notes de release
(`RELEASE_NOTES_URL`, la même adresse dans les quatre agents, vérifiée par `make check`).

La règle est unique et implémentée quatre fois — `showUpdateIfNew()` dans
[`pages.js`](../browser/src/pages.js), `updatedVersion()` dans le complément Word, `noteVersion()`
dans le panneau VS Code, `updated_version()` côté LibreOffice :

1. l'agent garde la version **que l'étudiant a vue** (`seenVersion`) ;
2. elle diffère de celle qui tourne → la ligne s'affiche, et la version vue est mise à jour ;
3. **elle est absente → c'est une première installation, pas une mise à jour** : la version est
   enregistrée en silence.

Le troisième point est le seul piège, et il se voit le jour de la livraison : lu comme une mise
à jour, il annoncerait à tous les étudiants déjà installés qu'ils viennent de passer à la
version qu'ils utilisent depuis un mois, et accueillerait chaque nouvelle installation par une
note sur une version qu'elle n'a jamais quittée. Les quatre suites le tiennent
(`browser/tests/update.test.mjs`, `word/tests/agent.test.mjs`, `vscode/tests/panel.test.mjs`,
`libreoffice/tests/test_engine.py`).

La ligne est **consommée en étant affichée** : la première des deux fenêtres ouvertes la dit, la
seconde se tait. Une version qui recule est annoncée comme une autre — une boutique qui
retirerait une version laisse l'étudiant sur autre chose que ce qu'on lui avait annoncé.

Trois des quatre agents n'ont que cette ligne : leur hôte a déjà installé la mise à jour quand
elle s'affiche. Le quatrième, LibreOffice, est le seul à avoir besoin qu'on lui dise qu'une mise
à jour **existe** ([extension-libreoffice.md](extension-libreoffice.md#mettre-à-jour-une-extension-déjà-installée)).

## Mode debug

La page d'options a une case **Mode debug**. Activée, elle :

- journalise dans la console du document chaque suppression et la case dans laquelle elle tombe
  (correction immédiate, reformulation différée, révision massive), les collages — avec la part
  reprise du texte que l'étudiant a lui-même copié, qui en fait une révision plutôt qu'une
  injection ([mesures.md](mesures.md)) —, les sorties du document et chaque fenêtre envoyée ;
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

Pour un moteur local, ouvrir les **paramètres avancés** du formulaire et saisir
`http://localhost:8080` comme adresse du moteur : l'extension demande alors l'accès à cet hôte
(`optional_host_permissions`).

### Sur mobile : déclaré, jamais mesuré sur un appareil

Le manifest déclare Firefox pour Android (`gecko_android`) et le projet Xcode construit une app
iOS : les paquets s'installent donc sur mobile, et les fiches de boutique le disent. **Ce qui n'a
jamais été vérifié sur un appareil, c'est la mesure elle-même** — un navigateur mobile sur
`docs.google.com` est redirigé vers une version de l'éditeur qui n'a ni les mêmes sélecteurs ni
l'iframe de saisie, quand il ne renvoie pas vers l'application native, où aucune extension ne
tourne. Tant que l'essai n'est pas fait, la promesse de boutique tient à un paquet qui s'installe,
pas à un capteur qui compte. C'est le premier essai à faire sur un vrai téléphone.
