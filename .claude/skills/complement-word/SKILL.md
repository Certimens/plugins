---
name: complement-word
description: Complément Office pour Word (word/, Office.js, runtime partagé, manifest.xml, hébergement GitHub Pages) — capteur par différences de texte, file hors-ligne partagée entre documents, CORS du moteur et validation AppSource. À charger avant toute modification dans word/ ou du manifest Office, et avant de diagnostiquer un volet qui ne se recharge pas.
---

# Complément Word (Office Add-in)

`word/` mesure la rédaction dans Word pour Windows et Mac (Microsoft 365, Mac 2019+) et Word sur
le web. `sensor.js` est le capteur (voir `mesures-redaction`), `agent.js` l'envoi au moteur,
`taskpane.html`/`taskpane.js` le volet, `index.html` la page d'accueil du site.

## Une page web, pas un paquet

Le complément est **servi par GitHub Pages** (`https://certimens.github.io/plugins/word/`) :
le manifest ne contient que des URL. Conséquences :

- `word/src/manifest.xml` est un **gabarit** : `{{BASE_URL}}` et `{{VERSION}}` sont remplacés par
  `word/build.mjs`. Ne jamais y écrire d'URL ou de version en dur.
- Le manifest fige **cinq adresses** chez l'étudiant installé : `taskpane.html` et les quatre
  icônes. **Ne jamais les déplacer** — ce qu'on y change n'atteint personne de déjà installé,
  et il faudrait redéployer un manifest à tout le monde.
- Le volet se **rattrape tout seul** du cache : un script inline en tête de `taskpane.html`
  compare la version gravée dans la page au `version.txt` du site, reprend les huit fichiers
  par-dessus les caches et recharge. **Un fichier ajouté au volet s'ajoute à sa liste
  `FILES`**, sinon il restera périmé.
- Ce script est inline parce que c'est le seul code qui tourne encore quand les fichiers
  d'en dessous sont cassés — ne pas l'externaliser. Et **ne jamais toucher au garde-fou** sans
  y réfléchir à deux fois : une boucle de rechargement toucherait tous les étudiants d'un
  coup. Une fois par session, jamais de seconde tentative, rien du tout sans `sessionStorage`.
- Pas de version dans les URL (`?v=`) ni de dossier versionné : `deploy-pages` remplace le site
  entier, donc un dossier précédent disparaît et une page encore cachée réclamerait des
  adresses que plus personne ne sert.
- Office impose une version à **quatre nombres** (`X.Y.Z.0`) et ne peut pas porter le commit.
- L'`<Id>` ne doit **plus jamais changer** une fois publié sur AppSource.
- **Le site Pages n'est pas qu'à lui** : il porte aussi `/libreoffice/update.xml`, le flux de
  mise à jour de l'extension LibreOffice, et `deploy-pages` remplace le site **entier**. D'où
  `pages.yml`, seul endroit du dépôt qui déploie, et qui reconstruit le complément au dernier
  tag `word-v*` quand c'est LibreOffice qu'on publie (`docs/publication.md`).
- Publier un correctif ne demande ni release ni tag : `gh workflow run pages.yml --ref ma-branche`
  republie le site. C'est **la production** qui est remplacée ; pour un essai sans conséquence,
  `make -C word serve` + `word/dist/word-localhost.xml`.
- Le moteur autorise cette origine en CORS sur `/api` (`https://certimens.github.io`, plus
  `https://localhost:3000` en développement) ; la liste est tenue côté moteur. Changer
  d'hébergement impose donc un changement là-bas, à demander avant de publier.

## Runtime partagé

`SharedRuntime` (déclaré dans `<Requirements>`) garde la page chargée **volet fermé** : c'est ce
qui maintient la mesure en vie. Il exclut Word 2016/2019, dont le moteur Internet Explorer ne
peut pas exécuter le complément — ne pas abaisser cette exigence pour élargir le support.

Chaque document ouvert a son instance du complément, mais **tous partagent le même
`localStorage`** (même origine). D'où le bail dans `agent.js` : `RUNTIME_ID` + `LEASE_MS`, un
seul draineur de file à la fois, bail renouvelé à chaque envoi. Toute nouvelle écriture partagée
doit passer par ce mécanisme ou être idempotente.

L'identifiant du document vit dans ses **propriétés personnalisées**
(`DOCUMENT_ID_PROPERTY`, lues sous le même nom par l'extension LibreOffice) : il voyage avec le
`.docx`. Les réglages Office (`DOCUMENT_ID_SETTING`) ne sont plus que le repli d'un Word sans
WordApi 1.3. Il est résolu **une fois par volet** (`documentId()` garde sa promesse) : le volet
et le capteur le demandent tous deux, et deux réponses seraient deux identités.

**Une identité liée à un autre emplacement pose une question, une fois** (`MOVED OR COPIED` dans
`agent.js`, `docs/complement-word.md`) : renommé/déplacé, ou copie ? Word ne peut pas tester
l'ancien emplacement, donc c'est l'étudiant qui répond. Ce qui doit tenir :

- en attendant, le fichier est mesuré sous une identité **provisoire**, inscrite dans `held` :
  ses fenêtres entrent dans la file mais **aucune ne part** (`holdBack`, une fois par vidage, bail
  en main, qui les range derrière les autres pour que le curseur ne passe jamais par-dessus). Ne
  jamais faire attendre `ensureDocument` sur la réponse : la file est commune, elle bloquerait
  tous les documents pendant des heures ;
- « le même fichier » passe par `rejoin`, **sous `withLock` et synchrone** de la première lecture
  au dernier écouteur : fenêtres ramenées sous l'identité d'origine, lien déplacé,
  `resolvedDocumentId` remplacé — seule exception à « une fois par volet » —, et
  `onDocumentIdChange` prévient le volet (`current.docId`) et le capteur (`followDocument`), dont
  la session continue. Le moteur est interrogé **avant** (`403`/`404` → refus) : c'est lui
  l'autorisation, et la question nomme le dossier qu'on rejoindrait ;
- « une copie », pas de réponse (`pagehide`), une déconnexion (`drain(true)` ignore la retenue) ou
  un changement de compte (`clearAccountState`) : le comportement d'avant, rien d'autre. Une
  retenue que plus personne ne renouvelle s'éteint (`HOLD_MS`) ;
- la réponse est retenue par identité et emplacement (`relocations`) ; `relocations` et `held`
  sont de l'état de compte (`ACCOUNT_KEYS`).

**Le verrou de la file ne se prend jamais depuis ce que la file attend.** `ensureDocument` tourne
sous `withLock` et attend la reprise en cours (`pendingResume`) ; la reprise ne prend donc pas ce
verrou — elle le faisait, et la file s'arrêtait pour de bon à la première fenêtre scellée
pendant une reprise. Une reprise qui n'a pas pu être *posée* (personne de connecté, pas de
réseau) n'a rien décidé : elle est redemandée avant toute création (`resumeFor.settled`), et
après chaque appairage.

**Trois écritures passent sous le verrou** parce qu'elles effacent : la déconnexion, l'adoption
d'un jeton (changement de compte) et la file. `enqueue` refuse une fenêtre quand personne n'est
connecté, et `logout` vide la file en **forçant le bail** — sans quoi le volet d'à côté, qui le
tenait, laissait effacer des fenêtres jamais parties. Le bail est rendu à la fin de chaque
vidage.

## Capteur par différences

Office ne livre pas les frappes. Chaque modification locale (changement de sélection, paragraphe
modifié, WordApi 1.6) déclenche une relecture du texte, et la différence dit ce qui a été inséré
ou effacé. À préserver :

- `MIN_READ_INTERVAL_MS` (250 ms) : une relecture au plus par quart de seconde ;
- `BASELINE_REFRESH_MS` (5 s) : sans événement local depuis la dernière lecture, le texte relu
  devient simplement la nouvelle référence — c'est ainsi que les modifications des **co-auteurs**
  sont ignorées plutôt que comptées comme frappe ;
- `STRUCTURE_CHARS` : les caractères de structure et invisibles de Word ne sont pas du volume.

Ne jamais conserver le texte au-delà de la lecture précédente, ni l'envoyer.

## Tester en local

```bash
make -C word build && make -C word serve   # HTTPS sur localhost:3000, certificat de dev au 1er lancement
make -C word lint                          # ESLint, types (tsc), html-validate
make -C word lint-manifest                 # validation Microsoft du manifest (après build, réseau requis)
```

Charger `word/dist/word-localhost.xml` : sur le web via *Accueil › Compléments › Mes compléments ›
Charger mon complément* ; sur Windows/Mac via
`npx office-addin-debugging start word/dist/word-localhost.xml desktop`.

**Le volet montre encore l'ancien code ?** C'est le cache avant tout : Pages sert les fichiers
quelques minutes, et Word garde le sien (`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS). Vérifier ce qui est en
ligne avec un `curl` sur `…/plugins/word/src/manifest.xml` avant de soupçonner le code.

## Signaler un problème

Le lien du bas du volet ouvre le formulaire d'aide du moteur, prérempli (`reportLink()` dans
`agent.js`, bloc construit par `report.js`, lien symbolique vers l'extension). Il s'ouvre par
`Office.context.ui.openBrowserWindow` quand `OpenBrowserWindowApi 1.1` est là (Windows, Mac,
iPad) : sur le bureau, un `window.open` reste dans la *webview* d'Office. Word pour le web n'a
pas cet ensemble, et y retombe sur `window.open(url, '_blank', 'noopener')`. `host` vient
d'`Office.context.diagnostics` ; jamais le nom ni l'adresse du document.

## Double comptage

Sur Word pour le web, le complément et l'extension navigateur mesurent la même rédaction. Le
volet le rappelle à l'étudiant ; toute évolution de l'un ne doit pas faire disparaître cet
avertissement.

## Mesure suspendue

`isPaused()` relit `localStorage` **à chaque appel**, sans cache : chaque document ouvert a son
instance du complément, elles partagent cette origine mais pas leur mémoire, et une pause décidée
dans l'une doit atteindre les capteurs des autres.

Pendant la pause (ou hors connexion de compte), **rien n'est lu** : la référence est marquée
périmée (`stale`), et la première lecture qui suit la remplace sans rien compter. Le volet
demande cette lecture au moment où l'étudiant reprend, donc la première frappe d'après est
comptée comme une autre. La relecture continuait auparavant pendant la pause, sur son minuteur,
et laissait un trou large comme son délai : vingt secondes de texte tapées juste avant de
reprendre devenaient un collage. Ce qu'un geste a laissé en attente (déplacements sans fenêtre,
trajet, rafale, sélection) est oublié avec la session (`forgetGestures`).

## Langues

Le volet n'a pas de dictionnaire à lui : il charge `i18n.js` de l'extension, que le build copie
dans `word/dist/word/`. Le manifest, lui, est traduit par Office (`<Override Locale="en-us">` sur
`DisplayName`, `Description` et les `bt:String`), d'après la langue d'Office et non celle du
compte Certimens. Règle complète : skill `langues-interface`.

## Contrôle de types

`make -C word lint` passe le vérificateur de TypeScript sur `src/` (`jsconfig.json`, `checkJs`,
`noEmit`, types en JSDoc) : aucun `.ts` livré, aucune transpilation — le fichier vérifié est le
fichier servi. Office.js est typé par `@types/office-js`.

`src/ui.js`, `src/i18n.js` et `src/report.js` sont des liens vers l'extension navigateur, et **rien dans ce qu'ils
déclarent ne touche à `chrome.*`** : ce que seule l'extension peut faire — la langue de la page,
la demande d'accès au moteur — vit dans son `pages.js`, que le volet ne charge pas. Les deux
fonctions en question ont longtemps vécu dans `ui.js` : du code mort livré dans le volet, et une
mine pour qui les aurait appelées. `types/shared-ui.d.ts` n'a donc plus rien à déclarer, et le
dit plutôt que de disparaître — c'est là que la question revient le jour où une fonction
partagée demandera une API de navigateur.

Dans l'autre sens, ce que le volet déclare pour lui-même reste chez lui : `agent.js` porte
`DEFAULT_ENGINE_URL`, comme `engine.js` chez VS Code et `engine.py` chez LibreOffice, et
`make check` compare les quatre. **Ce qui s'ajoute à `ui.js` doit marcher des deux côtés** — une
règle que le vérificateur de types ne voit pas, les deux hôtes n'étant jamais lus ensemble.

## Pas de `make test-host` ici, et c'est définitif

Les trois autres agents lancent leur code dans un hôte réel, en conteneur. Celui-ci ne le peut
pas : **Office.js ne s'exécute que dans Word**, il n'existe pas de Word sans affichage, et
charger `taskpane.html` dans un navigateur contre un faux Office.js reviendrait à remplacer
l'hôte par un double — ce que `make test` fait déjà.

La conséquence est à dire plutôt qu'à contourner : pour cet agent, la vérification dans l'hôte
est **entièrement manuelle**, et `word/TESTING.md` en est la liste — sideload dans Word Desktop
*et* Word Online, capteur par différences, runtime partagé, réouverture automatique, deux
documents à la fois. Elle se rejoue avant chaque tag `word-v…`.
