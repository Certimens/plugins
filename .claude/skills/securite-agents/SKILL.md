---
name: securite-agents
description: Ce qui protège l'étudiant et son jeton dans les quatre agents — où vit le jeton, ce qui ne quitte jamais le poste, les schémas d'URL acceptés, les chaînes que le moteur renvoie et dont rien n'est de confiance, la CSP de chaque contexte, les permissions et le geste qui les accorde. À charger avant de toucher au stockage d'un jeton, à une URL, à un en-tête, à une permission, à une redirection, et avant d'ajouter un lien, une page ou une chaîne venue du moteur dans l'interface.
---

# Sécurité des agents

Les agents sont livrés en clair et tournent sur le poste de l'étudiant : rien ici ne repose sur
le secret du code. Ce qui est défendu tient en trois choses — **le jeton d'API**, **le texte que
l'étudiant écrit**, et **la frontière de chaque contexte d'exécution**. Tout le reste est public
par construction.

## Le jeton

C'est le seul secret qu'un agent détient. Il vaut 180 jours et n'ouvre que les routes d'un agent
([docs/moteur.md](../../docs/moteur.md)), donc ce qui le lit une fois le lit pour des mois.

| Agent | Où il vit | Qui d'autre peut le lire |
| --- | --- | --- |
| Extension navigateur | `chrome.storage.local`, fermé aux content scripts (`setAccessLevel` posé à chaque démarrage du worker) là où le navigateur le permet | l'extension seule sous Chromium ; **aussi ses content scripts** sous Firefox (pas de `setAccessLevel`) et sous Safari avant 27.2 |
| Complément Word | `localStorage` du volet | **toute page de la même origine** (voir ci-dessous) |
| Extension LibreOffice | `certimens.json`, ouvert en `0o600` dès la création | l'utilisateur seul |
| Extension VS Code | le `SecretStorage` de l'éditeur | l'extension seule |

Trois règles, sans exception :

- **Jamais dans un `settings.json`, un fichier de configuration versionnable, un journal, un
  message d'erreur, une URL ou un paramètre de requête.** Il voyage dans l'en-tête
  `Authorization`, et nulle part ailleurs.
- **Un content script ne lit jamais le stockage qui porte le jeton** : il reçoit du worker des
  valeurs nommées une à une (`CERTIMENS_SENSOR_STATE` : `debug`, `paused`, `signedIn`, `sites`),
  comme `publicPairing`. Un script de contenu tourne dans la page d'un site quelconque que
  l'étudiant a ajouté.
- **Le lien « Signaler un problème » ne porte que des états** (docs/moteur.md) : il ouvre le
  formulaire d'aide de l'espace Certimens avec un bloc dans le **fragment**, que le navigateur
  n'envoie pas au serveur. Ni jeton, ni `device_code`, ni e-mail, ni document, ni site, ni
  texte ; le moteur y est donné par son **origine** seule — un `user:secret@` écrit dans
  l'adresse ne passe pas. Dans l'extension, la requête qui l'ouvre (`CERTIMENS_REPORT`) n'est
  acceptée que de ses propres pages.
- **Jamais rendu à une page.** C'est la raison d'être de `publicPairing()` dans
  `browser/src/background.js` : la popup reçoit les champs nommés un par un, pas l'objet
  d'appairage moins un champ — un champ ajouté plus tard n'est ainsi pas publié par défaut. Le
  `device_code` suit la même règle que le jeton : c'est le justificatif de l'agent.
- **La déconnexion le révoque** (`DELETE /api/auth/tokens/:id`) avant de l'effacer. Un jeton
  effacé sans être révoqué reste vivant côté moteur.
- **Un jeton remis n'est jamais lâché.** Le moteur ne le donne qu'une fois : entre le sondage
  qui le rend et les deux appels qui l'adoptent (`/me`, `/tokens`), il est gardé avec
  l'appairage, et une adoption restée sans réponse est redemandée — sinon il restait vivant
  côté moteur sans que personne puisse le révoquer. De même, **le jeton qu'un nouvel appairage
  remplace est révoqué**, pas abandonné (extension navigateur, où la page d'options propose de
  se reconnecter sans se déconnecter).
- **Ce qu'un compte a laissé ne part pas sous le suivant.** Trois verrous, dans les quatre :
  la fenêtre encore ouverte est scellée et envoyée *avant* la révocation ; l'effacement (file,
  documents connus) se fait sous le verrou de la file, jeton d'abord ; et la mise en file
  **refuse une fenêtre quand personne n'est connecté** — le minuteur d'une frappe tapée pendant
  la déconnexion scelle toujours après. Dans VS Code, où chaque fenêtre de l'éditeur a sa file,
  c'est `accountEpoch` qui porte la déconnexion aux autres (`docs/extension-vscode.md`).

Le fichier de LibreOffice est créé en `0o600` **par `os.open`, pas par un `chmod` après coup** :
entre la création et le `chmod`, le fichier serait lisible selon l'umask du processus.

### L'origine du volet Word est partagée

Le volet est servi par `https://certimens.github.io/plugins/word/` : l'origine est
`certimens.github.io`, et **le chemin n'isole rien**. `localStorage` est indexé par origine, donc
toute page Pages publiée par n'importe quel dépôt du même compte GitHub lit le jeton de
l'étudiant, et une XSS sur n'importe laquelle d'entre elles l'emporte.

Conséquence pratique : **ne pas publier un second site Pages sous ce compte** sans traiter le
problème, et traiter le problème, c'est **donner au volet son propre domaine** (un `CNAME` vers
GitHub Pages). Ce changement touche trois endroits à la fois — `WORD_BASE_URL` du build, la
`SourceLocation` du manifest (donc un nouveau dépôt AppSource), et **la liste des origines
autorisées côté moteur**, qui est un chantier de l'autre côté à demander avant de publier.

## Ce qui ne quitte jamais le poste

Aucun texte rédigé par l'étudiant ne part — les agents n'envoient que des compteurs. Deux
exceptions, et elles sont **explicites, sur un clic** : le dépôt de la copie
(`PUT /api/documents/:id`) et le texte d'un champ de page (`deposit: 'text'`).

Ce qui est retenu en mémoire du texte sorti du document est **haché** (empreintes FNV-1a de
quatre mots, voir `mesures-redaction`), borné à vingt copies et périmé au bout d'une heure. Le
presse-papiers lui-même n'est **jamais** lu : un évènement `copy` ne porte pas encore de données,
et demander le presse-papiers exigerait une permission que l'extension n'a aucune raison de
tenir.

Le mode debug enregistre **des catégories et des compteurs, jamais un caractère, jamais une
touche**. Une ligne de journal qui porterait du texte de l'étudiant est un défaut, pas un détail.

## Les URL

- **Deux schémas, pas un de plus** : `http:` et `https:`. C'est ce que vérifient
  `siteMatch()` (`browser/src/options.js`), `requestEngineAccess()` (`browser/src/pages.js`) et
  `_request()` (`libreoffice/.../engine.py`, dont le `# noqa: S310` tient précisément à ce
  contrôle — `urlopen` ouvrirait sinon un `file://` ou parlerait ftp).
- **Rien d'extérieur n'est interpolé dans un chemin d'API sans être validé.** `exportGoogleDoc()`
  le fait (`/^[a-zA-Z0-9_-]+$/`), `engineDocumentId()` le fait pour l'identifiant qui arrive dans
  un message. Un message est la seule entrée du *service worker* dont personne d'autre n'a
  vérifié la forme : une barre oblique dedans n'est plus un identifiant, c'est une autre route,
  appelée avec le jeton de l'étudiant.
- **Les redirections ne se valent pas d'un agent à l'autre.** `fetch` retire `Authorization`
  quand la redirection change d'origine — les trois agents JavaScript en héritent sans rien
  faire. `urllib` **le conserve**, y compris vers un autre hôte et y compris en rétrogradant
  `https` vers `http` : son gestionnaire recopie tous les en-têtes sauf `Content-Length` et
  `Content-Type`, ce qui se vérifie en deux lignes sur `HTTPRedirectHandler.redirect_request`.
  D'où `SafeRedirect` et l'`OPENER` unique de `libreoffice/.../engine.py` : la redirection est
  suivie, seul le justificatif reste derrière. **Ne jamais revenir à `urlopen` directement** —
  poser la règle sans la brancher serait pire que de ne pas la poser, et un test le dit.

### `http:` seulement là où la requête ne sort pas du bâtiment

Hors d'un hôte local, `http:` ferait voyager en clair un jeton qui n'expire pas : les quatre
agents le refusent (`engineUrlAllowed` / `engine_url_allowed`, phrase `error.engineUrlInsecure`),
à la saisie **et** à chaque appel. Sont acceptés en `http:` un nom à une seule étiquette (pas
tout en chiffres), la boucle locale, `*.local`, les plages privées et les ULA — le déploiement
qui le justifie est l'intranet d'un établissement. Le motif `LOCAL_ENGINE_HOST` est tenu
caractère pour caractère par les quatre et comparé par `make check` ; la table est dans
`docs/moteur.md`.

Le piège est du côté Python : `new URL` réécrit `http://0x08080808/` en `8.8.8.8` avant que le
motif le voie, `urlparse` le rend tel quel — une seule étiquette, donc « local » — et le
résolveur y lit l'adresse publique. `engine_url_allowed` refuse donc une étiquette unique que
`socket.inet_aton` sait lire.

Deux précisions : le volet Word est une page `https:`, donc le navigateur lui interdit de
toute façon un moteur en `http:` hors boucle locale (contenu mixte) ; et la règle ne concerne
que le moteur — un **site** que l'étudiant ajoute peut être en `http:`, aucun jeton n'y va.

## Rien de ce que le moteur renvoie n'est de confiance

Le moteur est joint à une adresse que l'étudiant peut changer : ses réponses sont des **données**,
jamais des instructions, et jamais du balisage.

- `verification_uri_complete` devient un `href` dans **quatre** fenêtres
  (`browser/src/options.js`, `browser/src/popup.js`, `word/src/taskpane.js`,
  `vscode/src/panel.js`) et un `openExternal()` dans `vscode/src/extension.js`. Il est donc filtré
  **à l'entrée** — `verificationUri()` / `verification_uri()` dans le client de chaque agent, là
  où la réponse d'appairage est lue — et non aux cinq endroits où il est posé : une fenêtre de
  plus demain n'aurait pas à y penser. Tout ce qui n'est pas `http:`/`https:` retombe sur la page
  `/device` du moteur ; l'appairage reste valide, seul le raccourci est perdu.
- La liste des sites que l'établissement propose (`writing_sites`, dans `GET /api/auth/me`) est lue de la même façon : l'extension n'en
  garde que ce qu'elle peut **réellement** demander à un navigateur (`https`, une origine
  exacte), et jette le reste sans un mot.
- `error`, `display_name`, `name`, `email` s'affichent : ils passent par `textContent`, par
  `esc()` dans la webview VS Code, jamais par une concaténation de balisage.
- **Aucun `innerHTML`, aucun `insertAdjacentHTML`, aucun `eval`, aucun `new Function` dans
  `*/src/`.** Le dépôt est à zéro aujourd'hui : c'est une propriété à tenir, pas un hasard, et
  elle se vérifie d'un `grep`.

## La CSP de chaque contexte

| Contexte | Ce qui l'enferme |
| --- | --- |
| Pages de l'extension (popup, options) | la CSP par défaut de MV3 : `script-src 'self'`, qui bloque aussi les URL `javascript:` |
| *Service worker* | pas de DOM, pas de page |
| Webview VS Code | `default-src 'none'`, script sous *nonce* tiré de `crypto.randomBytes` (`panel.js`) |
| Volet Word | **rien** : c'est une page web ordinaire, et la seule qui garde le jeton dans `localStorage` |

Le volet charge `office.js` depuis le CDN Microsoft (AppSource l'exige) et porte un script
*inline* — celui de la reprise de cache. Une CSP y reste donc possible, à condition de nommer
cette origine et de donner au script *inline* son empreinte, calculée au build.

**Elle n'est pas posée, et c'est délibéré.** Ce que ce dépôt sait vérifier s'arrête avant :
Office.js ne s'exécute que dans Word, le complément n'a pas de cible `test-host`, et une CSP qui
casserait le chargement casserait le volet de **tous** les étudiants d'un coup. Elle se pose donc
en même temps qu'une vérification dans un vrai Word, pas avant — `word/TESTING.md` porte la
liste de ce qu'il faut regarder. Surtout : **elle ne répond pas au problème ci-dessus.** Une CSP
sur cette page n'empêche pas une *autre* page de la même origine de lire le `localStorage` ;
seul un domaine propre le fait.

## Les permissions

- **Une permission se demande sur un geste.** `chrome.permissions.request()` ne fonctionne que
  dans un gestionnaire de clic, et un *service worker* n'en a pas : c'est pour cela que la page
  d'options demande, et que le worker se contente d'enregistrer.
- **On demande l'origine nommée, jamais plus large.** `siteMatch()` rend `origine + '/*'` ; un
  motif à étoile sur le domaine demanderait des sites que l'étudiant n'a pas nommés.
  `optional_host_permissions` porte `https://*/*` parce que c'est la seule façon de pouvoir
  demander *une* origine quelconque plus tard — ce n'est pas une permission tenue.
- **Retirer un site retire sa permission** (`CERTIMENS_REMOVE_SITE`), et `syncSiteScripts()`
  réconcilie dans l'autre sens : une permission révoquée depuis les réglages du navigateur ne
  doit pas laisser un script enregistré.

## Ce qui engage les deux côtés

Ces changements-là ne tiennent pas dans ce dépôt seul, et le moteur passe **en premier** :

- changer l'hébergement du volet Word → la liste des origines CORS du moteur ;
- ajouter un appel, un champ ou une metric → la forme acceptée côté moteur ;
- desserrer le limiteur de débit rencontré pendant un appairage (`429`) → son plafond.
