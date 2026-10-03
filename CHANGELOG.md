# Journal des versions

Ce que chaque version apporte à l'étudiant et à l'enseignant. **Chaque agent suit sa propre
ligne de versions**, par un tag qui le nomme : `browser-vX.Y.Z`, `word-vX.Y.Z`,
`libreoffice-vX.Y.Z`, `vscode-vX.Y.Z`. Une section porte donc l'agent et sa version —
`## browser 1.0.0` — et un agent qu'aucun commit n'a touché ne sort pas : une boutique relit
chaque dépôt, et republier un paquet identique au précédent coûte une relecture pour rien
([`docs/publication.md`](docs/publication.md)).

**La section de la version s'écrit avant le tag**, pas après : la release en fait ses notes et
**échoue si elle manque**. `python3 scripts/changelog-section.py <agent> <version>` montre ce
qu'elle publiera.

Chaque version porte, en fin de section, les deux phrases à coller dans le champ
**« Nouveautés »** des boutiques de l'agent concerné — en français et en anglais, parce
qu'aucune boutique ne traduit une fiche à partir du paquet
([`browser/store/README.md`](browser/store/README.md)).

La section **Non publié** est commune aux quatre, et elle ne se vide jamais entièrement : ce qui
ne voyage dans aucun paquet — l'outillage, la CI, ce qui compare les quatre agents entre eux —
n'appartient à la version d'aucun agent et reste là. Le reste s'y accumule jusqu'au tag qui le
publie.

La version vient de git : elle ne s'incrémente jamais à la main dans un manifest.

## Non publié

Ce qui vit dans le dépôt sans entrer dans un paquet : aucune boutique ne le verra, et aucune
version ne le porte.

- **Copier une phrase de son propre document et la recoller n'est plus une injection.** C'est le
  geste le plus banal qui soit — reprendre un intitulé, dupliquer une formule, déplacer un
  paragraphe — et deux agents sur quatre le comptaient comme du texte importé de l'extérieur. Le
  complément **Word** ne reçoit aucun événement de copie : il ne retenait que ce que la
  différence voyait disparaître, donc un Ctrl+C sans suppression ne laissait aucune trace. Il
  retient désormais le **bloc sélectionné**, ce qui ne peut excuser que du texte lu dans le
  document lui-même. L'extension **VS Code**, qui ne voit ni le presse-papiers ni le contenu de
  ce qu'une modification remplace, compare l'insertion au **document** : un texte qu'il
  contenait déjà ailleurs ne peut pas avoir été importé par le geste qui l'y met une seconde
  fois. Elle envoie donc `self_paste_chars_total` — le volume des restitutions — sans envoyer
  leur nombre, qu'elle ne sait toujours pas distinguer d'une complétion acceptée
  ([`docs/mesures.md`](docs/mesures.md)).

- **Une adresse de moteur en clair ne sort plus du bâtiment.** L'étudiant peut désigner un autre
  moteur que celui par défaut — un établissement qui héberge le sien — et cette adresse décide
  où part un jeton d'API **qui n'expire pas**. Les quatre agents acceptaient `http:` vers
  n'importe quel hôte : sur un moteur public joint en clair, le jeton traversait le réseau
  lisible, et un jeton lu une fois est un jeton gardé. Le refuser tout court aurait cassé le
  déploiement qui le justifie, un moteur servi sur l'intranet d'un établissement sans certificat
  ni nom public — la règle porte donc sur l'**hôte** : `http:` reste accepté vers la boucle
  locale, un nom à une seule étiquette, du `.local` et les plages privées, et `https:` est
  obligatoire partout ailleurs. Les fenêtres le disent au moment de la validation, les clients
  le redisent à chaque appel — ce qui couvre une adresse enregistrée avant la règle — et le
  motif est le même caractère pour caractère dans les quatre agents, ce que `make check` compare
  désormais ([`docs/moteur.md`](docs/moteur.md)).

- **Les jobs qui publient n'installent plus l'outillage de lint à côté des identifiants.** Les
  jobs qui déposent dans les boutiques, sur le Marketplace et sur GitHub Pages sont les seuls du
  dépôt à porter des secrets — clé du compte de service Chrome, secret JWT d'AMO, jeton du
  Marketplace. Ils faisaient `npm ci`, qui exécute le script d'installation de chacun des
  paquets de l'arbre, soit 477 pour l'agent navigateur, ESLint, Playwright et web-ext compris.
  Aucun n'en déclarait, mais rien ne le disait et Dependabot ouvre un PR groupé chaque lundi.
  Ces jobs installent désormais par `make -C <agent> install-publish`, sans exécuter aucun
  script, et un **lint de dépendances** compare le verrou à la liste des paquets autorisés à en
  avoir un : la propriété est tenue au lieu d'être heureuse
  ([`docs/publication.md`](docs/publication.md)).

- **Quatre durcissements que l'étudiant ne verra pas.** Le service worker de l'extension
  n'acceptait un message sans regarder d'où il venait : un script de contenu — qui tourne dans
  les pages que l'étudiant ajoute, donc potentiellement n'importe où — pouvait lui demander ce
  que seules ses fenêtres ont à demander, dont **ouvrir un appairage vers un autre moteur**, ce
  qui déplace le compte et tout ce qui se mesure avec. Rien sur le web ne l'atteignait, et c'est
  précisément ce qu'on vérifie une fois plutôt que de l'espérer. L'extension LibreOffice
  écrivait son jeton par un fichier temporaire au nom prévisible, que `O_CREAT` seul suit s'il
  est un lien et dont il ne corrige pas les droits — c'est `mkstemp` qui s'en charge désormais,
  et le `0600` à la création protège enfin quelque chose. Le journal d'un envoi refusé ne porte
  plus la fenêtre entière, dont l'identifiant est l'adresse complète de la page sur un site
  ajouté. Et le serveur de développement du complément Word n'écoute plus que la boucle locale.

- **Les quatre agents disent pourquoi ils ont vidé une fenêtre.** Une fenêtre de mesure n'est
  pas une rafale de frappe : c'est une période que l'agent a décidé de clore, et il la clôt
  pour quatre raisons qui ne disent pas la même chose de l'étudiant — il s'est arrêté de taper,
  le compteur a atteint son plafond, il a enregistré, il a quitté le document. Les agents le
  savaient et ne le disaient pas ; le moteur devait le deviner de la seule suite des fenêtres,
  et se trompait dans les deux sens : un `Ctrl+S` réflexe coupait une rafale en deux et
  ressemblait alors à quelqu'un qui ne s'arrête jamais, tandis qu'un aller-retour vers une
  seconde fenêtre ressemblait à un silence de réflexion. Chaque mesure porte désormais le mot
  qui le dit, dans un vocabulaire de six mots commun aux quatre
  ([`docs/mesures.md`](docs/mesures.md), [`docs/moteur.md`](docs/moteur.md)).

- **Une documentation d'installation, publiée et bilingue.** Rien dans ce dépôt ne disait à un
  étudiant — ni à l'établissement qui l'équipe — comment installer un agent : les pages de
  `docs/` sont écrites pour qui travaille sur le code. Le site publié à
  `certimens.github.io/plugins/` porte désormais une page par agent, en français et en anglais,
  avec le chemin ordinaire par la boutique et, replié en dessous, le chemin manuel : paquets de
  chaque version, déploiement par stratégie d'entreprise, et ce qu'il faut savoir avant
  d'équiper un parc. Les illustrations ne sont pas des captures : ce sont les fenêtres des
  agents, dans leur propre balisage et avec les phrases de leur propre dictionnaire — une clé
  renommée fait échouer le build plutôt que de laisser un écran faux en ligne. Les écrans des
  boutiques, eux, sont décrits en mots et jamais dessinés. Le site reprend l'habillage du site
  vitrine **en direct** : il est servi sur le même hôte, sa feuille de style est donc chargée
  telle qu'elle est publiée, et ces pages suivront ses évolutions sans que personne y revienne
  ([`docs/publication.md`](docs/publication.md)).

- **L'extension LibreOffice sait enfin qu'une version plus récente existe.** C'était le seul des
  quatre agents que personne ne mettait à jour : un navigateur met à jour ses extensions, le
  Marketplace les siennes, le volet Word est repris de son site à chaque ouverture — un `.oxt`
  installé, lui, ne savait rien, et le dépôt sur extensions.libreoffice.org n'y changeait rien,
  ce site étant un catalogue et non un service de mise à jour. L'extension dit désormais à
  LibreOffice où demander, et c'est le gestionnaire d'extensions qui compare, propose et
  installe : rien ne tourne chez l'étudiant pour ça, rien n'est à traduire, et les notes de la
  version sont à un lien. Le flux est écrit par la release et publié sur GitHub Pages, à côté du
  complément Word ([`docs/extension-libreoffice.md`](docs/extension-libreoffice.md),
  [`docs/publication.md`](docs/publication.md)).

- **Les quatre agents disent quand ils ont changé de version.** Une boutique installe une
  version nouvelle sans rien dire : l'étudiant retrouvait un bouton déplacé et n'avait nulle part
  où aller voir. Chaque agent annonce désormais une fois, dans sa propre fenêtre, la version qui
  tourne, avec un lien vers ce qu'elle change. Une installation neuve ne dit rien — elle n'a rien
  mis à jour — et la ligne ne se répète pas : la première fenêtre ouverte la dit, les suivantes
  se taisent ([`docs/extension-navigateur.md`](docs/extension-navigateur.md)).

- **L'établissement peut dire où ses étudiants rédigent**, et l'extension navigateur le propose.
  Aucun manifest ne nommera le Moodle de chaque établissement : l'étudiant devait taper
  l'adresse, et c'est là qu'il se trompait. L'école nomme désormais ses adresses une fois, depuis
  la page « Agents de mesure » de son espace, et chaque étudiant les retrouve dans les réglages
  de son extension, prêtes à accepter — elles voyagent avec le compte, donc sans un appel de
  plus. Cela **propose** et n'accorde rien : c'est le navigateur
  qui demande l'autorisation, une adresse à la fois, et l'étudiant reste libre de les refuser
  toutes comme d'ajouter une adresse que personne n'a proposée. Un moteur qui ne connaît pas
  encore la route ne propose rien, en silence ([`docs/moteur.md`](docs/moteur.md),
  [`docs/extension-navigateur.md`](docs/extension-navigateur.md)).

- **Les accents ne passent plus pour des déplacements.** Maintenir une lettre sur un Mac ouvre
  une palette d'accents, et les flèches qui la parcourent étaient comptées comme des sauts dans
  le document — pire, elles faisaient passer la correction suivante pour une reformulation
  différée, chez quelqu'un qui n'avait jamais quitté sa ligne. Une frappe prise par une
  composition (cette palette, un IME) compte toujours comme une frappe, mais rien d'autre n'en
  est lu. Et une touche morte — le `^` qui attend le `e` dont il fera `ê` — n'écrit rien par
  elle-même : elle est écartée comme une touche de modification, ce qui met enfin l'extension
  d'accord avec Word et VS Code, qui comptaient un caractère là où elle comptait deux frappes
  ([`docs/mesures.md`](docs/mesures.md)).

- **« Refaire » n'est plus compté comme une correction.** Ctrl/Cmd+Z annule, Ctrl/Cmd+**Maj**+Z
  remet ce qui avait été enlevé — l'inverse d'une correction. Les deux agents qui voient les
  touches les confondaient, ce qui gonflait les « corrections immédiates » de quiconque hésite à
  voix haute, et particulièrement sur un Mac où Cmd+Maj+Z *est* le raccourci de « refaire ». Au
  passage, la liste des touches de modification que l'extension écarte est complétée : elle ne
  nommait pas `Fn`, `Verr. Num` ni quelques autres, qui comptaient donc pour des frappes
  qu'elles n'ont jamais été ([`docs/mesures.md`](docs/mesures.md)).

- **Le capteur rend la main plus vite à l'étudiant qui écrit.** Quatre dépenses payées sur son
  propre fil ont disparu : le document n'est plus relu à chaque fenêtre mais au plus toutes les
  cinq secondes (c'était une mise en page synchrone de tout le panneau d'édition, plusieurs fois
  par minute) ; compter les caractères n'alloue plus un tableau par document ; un Ctrl+A/Ctrl+C
  sur une dissertation entière ne calcule plus ses empreintes dans le gestionnaire de l'événement ;
  et l'observateur du DOM n'est plus installé là où il n'avait rien à trouver — Word Online et
  Overleaf, les deux éditeurs qui remanient le plus leur page. Les empreintes sont désormais
  épinglées par des valeurs connues dans les quatre suites : le même texte doit donner le même
  nombre partout, sinon une restitution cesse d'être reconnue chez un agent, en silence.

- **Rattraper une journée hors ligne n'écrit plus la file à chaque fenêtre.** Entre deux envois,
  ce qui doit être écrit est « jusqu'où on est allé » — sans quoi une fenêtre repartirait — et
  c'était toute la file qui l'était : mesuré à 120 ms par écriture pour 5000 fenêtres côté
  LibreOffice, soit des minutes de disque et des gigaoctets écrits pour une seule reprise. Les
  quatre agents écrivent maintenant un curseur, et une reprise coupée en deux ne renvoie
  toujours rien deux fois.

- **Le jeton d'un étudiant ne suit plus une redirection hors du moteur.** L'agent LibreOffice
  parle par `urllib`, qui — contrairement au `fetch` des trois autres — recopie l'en-tête
  `Authorization` vers l'hôte d'arrivée, y compris en repassant de `https` à `http`. Ce jeton
  n'expire pas : celui qui fuit est gardé. La redirection est toujours suivie, le justificatif
  reste derrière. Par ailleurs, l'adresse que le moteur dit d'ouvrir pendant un appairage est
  désormais vérifiée à la lecture dans les quatre agents, avant d'atterrir dans un lien ou dans
  l'ouverture de navigateur de l'éditeur ([`SECURITY.md`](SECURITY.md)).

- **La période d'une fenêtre était transmise telle qu'elle sortait de la file**, et rien ne
  garantissait son ordre de clés. Le corps d'une mesure a une forme exacte, que le moteur
  accepte ou non : la mesure est construite à chaque envoi, donc dans l'ordre du code, mais la
  période venait du stockage de l'hôte, qui ne promet pas de rendre les clés dans l'ordre où on
  les a rangées — relue alphabétiquement, `{start, end}` devient `{end, start}`. Les quatre
  agents la **reconstruisent désormais clé par clé** au moment de l'envoi, et leurs suites le
  vérifient sur une file volontairement désordonnée ; le complément Word ne vérifiait aucun ordre
  de clés ([`docs/moteur.md`](docs/moteur.md)).

- **Trois agents se lancent dans leur hôte réel** (`make -C <agent> test-host`) : l'extension
  dépaquetée dans un vrai Chromium, l'extension VS Code dans un vrai VS Code à la version
  minimale qu'elle déclare, l'extension LibreOffice installée dans un vrai LibreOffice. Toutes
  les autres suites remplacent l'hôte par des doubles — `chrome.*`, `Office`, le module
  `vscode`, `uno` — ce qui leur permet de charger le fichier livré tel quel, et les empêche de
  voir la panne la plus bête et la plus coûteuse : celle où l'agent s'installe et ne fait rien.
  Un manifest refusé, un service worker qui jette au démarrage, une commande déclarée et jamais
  enregistrée, un `.oxt` que `unopkg` refuse : rien de tout cela n'échouait nulle part, et
  aucune boutique ne le relit. Chaque suite tourne dans un **conteneur jetable**, l'agent monté
  en lecture seule ; `make test-host-clean` rend la machine à son état d'avant. Hors de `make`,
  qui reste instantané et sans réseau, mais lancé **par la CI**, un job par agent : le dépôt est
  public et ses minutes de runner ne sont pas comptées, alors que « s'en souvenir avant chaque tag » est
  exactement ce qui se perd ([`docs/developpement.md`](docs/developpement.md)).
- **Un [`TESTING.md`](browser/TESTING.md) par agent** : ce qui reste à vérifier à la main, et
  pourquoi. Le DOM de Google Docs qui change sans prévenir, une fenêtre UNO illisible, le volet
  dans un vrai Word — ce qu'aucun hôte automatisé ne verra était jusqu'ici une connaissance
  orale. Le complément Word n'a que cette liste et n'aura jamais de `test-host` : Office.js ne
  s'exécute que dans Word, et le charger contre un faux Office.js reviendrait à remplacer l'hôte
  par un double.
- **Le vérificateur de types de TypeScript tourne sur les trois agents JavaScript**
  (`npm run lint:types`, donc `make lint`, donc la CI) : `checkJs`, `noEmit`, les types écrits en
  JSDoc là où ils servent. Aucun `.ts` livré, aucune transpilation, pas de bundler — le fichier
  vérifié reste le fichier livré, ce qui est la condition pour que les tests chargent le code de
  production tel quel. Il a trouvé, en arrivant : une balise `<meta>` lue comme un `Element`
  quelconque, deux tris de dates qui soustrayaient des objets `Date`, un gestionnaire Office
  rendant `undefined` là où Office attend une promesse, et `@types/vscode` à épingler à la
  version **minimale** déclarée par l'extension, sans quoi rien n'empêchait d'appeler une API
  absente de l'éditeur d'un étudiant ([`docs/developpement.md`](docs/developpement.md)).
- **Un agent, un tag, une version.** Un tag nomme son agent et ne construit, ne publie et ne
  version­ne que lui. Les quatre étaient versionnés ensemble : un tag redéposait les quatre
  paquets dans toutes les boutiques, y compris ceux dont pas une ligne n'avait changé, et chaque
  dépôt coûte une relecture (des jours, chez AMO et AppSource). Chaque build ne lit plus que ses
  propres tags et refuse bruyamment celui d'un autre agent
  ([`docs/publication.md`](docs/publication.md)).
- **Une release se lance d'un bouton**, *Actions › Release › Run workflow*, et **c'est le run
  qui pose le tag** — plus rien à faire sur le poste de qui publie. Le formulaire demande
  l'agent et laisse `dry_run` coché : lancé tel quel, il n'écrit qu'un **état des lieux** —
  pour chacun des quatre, son dernier tag, les commits qui ont touché *son paquet* depuis, les
  fichiers partagés qui en engagent plusieurs, et ce que ce journal lui consacre déjà. C'est la
  question qu'on se pose au moment de publier, « lequel des quatre a bougé ? », et à laquelle
  aucun agent ne peut répondre : il faudrait lire les trois autres et suivre les liens
  symboliques par lesquels `ui.css`, `i18n.js`, les polices et les icônes leur arrivent. Le run
  refuse de publier un agent dont le paquet n'a pas bougé depuis son dernier tag, une version
  qui n'avance pas, un tag déjà posé ou une section de journal manquante, et ne pose le tag
  qu'**après** une CI verte. Le tag poussé à la main reste accepté et déclenche le même workflow
  ([`docs/publication.md`](docs/publication.md)).
- **Les notes d'une release viennent de ce journal**, section par section — donc aussi les deux
  phrases bilingues que la boutique demande, qui ne sont plus à retrouver. La liste des commits
  dit ce que le dépôt a fait, mêle les quatre agents et ne se colle dans aucune fiche ; elle
  reste à un lien de distance.
- **`make check` compare les quatre agents entre eux** — constantes communes, metrics envoyées,
  forme de leurs noms, adresse du moteur par défaut, fichiers partagés par lien symbolique — et
  c'est le cinquième job de la CI. Rien ne le faisait : une règle de mesure désynchronisée dans
  un seul agent passait tous les linters et tous les tests.
- **`make coverage` dans les trois agents JavaScript**, avec un plancher par agent. Seul l'agent
  Python en avait un.
- [`SECURITY.md`](SECURITY.md) (où signaler une faille, et ce qui n'en est pas une),
  [`CONTRIBUTING.md`](CONTRIBUTING.md) et ce journal.

## browser 1.0.0

Première version de l'**extension navigateur** — Chrome, Firefox, Safari, Edge, Opera.

### Ce qu'elle fait

- **Mesure la rédaction dans Google Docs, Word Online et Overleaf**, sans jamais envoyer une
  ligne de ce que l'étudiant écrit : seulement des compteurs (frappes, corrections,
  reformulations, pauses, cadence, collages). Chaque document ouvert devient un document
  Certimens, créé au premier envoi et retrouvé ensuite.
- **L'étudiant déclare lui-même les autres sites où il rédige** — le Moodle de son
  établissement, un Canvas, un wiki. Un clic depuis la page : l'extension propose *Mesurer cette
  page*, le navigateur demande l'autorisation **pour cette origine seule**, et la mesure démarre
  sans recharger. La page d'options porte la liste, pour la relire et en retirer. Demander
  l'accès au web entier une bonne fois aurait été plus simple et plus mauvais : une fenêtre de
  mesure se serait ouverte dans une webmail ou un forum privé.
- **Moodle et Canvas sont reconnus** sur un site ajouté : le document prend le titre du devoir
  plutôt que celui de la page, et c'est le champ du devoir qui est lu. La fenêtre dit laquelle a
  été reconnue avant que l'étudiant appuie.
- **Rendre sa copie**, de trois façons selon l'éditeur : export direct depuis Google Docs,
  fichier choisi sur Word Online et Overleaf, et **texte de la page** sur un site ajouté — un
  devoir « texte en ligne » n'a pas de fichier à déposer. L'envoi est toujours un clic, jamais
  autre chose, et le texte est demandé à la page à ce moment-là.
- **La connexion se fait par un code**, confirmé dans l'espace Certimens : aucun mot de passe
  n'est demandé, nulle part. L'extension garde un jeton, révocable depuis l'espace.
- **La mesure se suspend**, d'un bouton, et reste suspendue jusqu'à ce que l'étudiant la
  reprenne — même après un redémarrage du navigateur. Pendant ce temps, rien n'est compté.
- **Hors ligne, rien n'est perdu** : les mesures attendent dans une file et repartent chaque
  minute. Chaque fenêtre dit si elle a été écrite pendant une coupure.
- **Un mode debug** dans la page d'options montre, en clair, exactement ce qui part.

### Ce qu'elle ne fait pas, et c'est voulu

- Overleaf n'envoie pas le volume du document : CodeMirror ne rend que les lignes visibles, et
  un volume faux tromperait le moteur plus sûrement qu'une absence
  ([`docs/extension-navigateur.md`](docs/extension-navigateur.md)).
- Aucun texte, aucune touche, aucun caractère ne quitte le poste.

### Nouveautés des boutiques

> **Français** — Certimens mesure votre façon de rédiger dans Google Docs, Word Online et
> Overleaf, et sur les autres sites que vous ajoutez vous-même — le Moodle de votre
> établissement, par exemple — où vous pouvez aussi rendre votre copie. Aucun texte ne quitte
> votre ordinateur : seulement des compteurs.

> **English** — Certimens measures the way you write in Google Docs, Word Online and Overleaf,
> and on the other sites you add yourself — your institution's Moodle, for instance — where you
> can hand in your copy too. No text ever leaves your computer: counters only.

## word 1.0.0

Première version du **complément Word**, servi par GitHub Pages et installé depuis AppSource.

### Ce qu'il fait

- **Mesure la rédaction dans Word**, Desktop et Online, par comparaison du texte : Office ne
  livre pas les frappes, le complément regarde ce qui a changé. Une « frappe » y est un
  caractère inséré ou effacé.
- **Continue de mesurer quand le volet est fermé** : c'est tout l'intérêt du runtime partagé
  déclaré par le manifest. Un document déjà lié rouvre le complément tout seul à l'ouverture.
- **Rendre sa copie** : le `.docx` part depuis le volet, sur un devoir auquel l'étudiant est
  rattaché.
- **La connexion se fait par un code**, confirmé dans l'espace Certimens — aucun mot de passe.
- **La mesure se suspend**, et la suspension vaut pour tous les documents ouverts dans ce Word :
  c'est l'étudiant qui suspend, pas un fichier. Elle survit au redémarrage.
- **Plusieurs documents ouverts partagent une file** et un seul d'entre eux la vide à la fois,
  pour qu'une mesure ne parte pas deux fois.

### Ce qu'il ne fait pas, et c'est voulu

- Pas de cadence de frappe ni de sortie du document : Office ne les livre pas, et une cadence
  calculée sur ses événements serait fausse ([`docs/mesures.md`](docs/mesures.md)).
- Aucun texte ne quitte le poste : le complément ne garde la lecture précédente du document que
  le temps de la comparaison.

### Nouveautés des boutiques

> **Français** — Certimens mesure votre façon de rédiger directement dans Word, sur votre
> ordinateur comme en ligne, et vous permet de rendre votre copie sans quitter le document. La
> mesure continue même quand le volet est fermé. Aucun texte ne quitte votre ordinateur :
> seulement des compteurs.

> **English** — Certimens measures the way you write inside Word, on your computer as well as
> online, and lets you hand in your copy without leaving the document. Measurement carries on
> even when the pane is closed. No text ever leaves your computer: counters only.

## libreoffice 1.0.0

Première version de l'**extension LibreOffice Writer**, paquet `.oxt` en Python/UNO.

### Ce qu'elle fait

- **Mesure la rédaction dans Writer**, clavier et souris compris : c'est, avec l'extension
  navigateur, le seul agent qui voit les vraies frappes, donc la cadence et sa régularité.
- **Une fenêtre Certimens** par document, ouverte depuis le menu *Certimens* ou depuis la barre
  d'information qui propose de lier un document qui ne l'est pas encore.
- **La connexion se fait par un code**, confirmé dans l'espace Certimens — aucun mot de passe.
- **La mesure se suspend** et le reste jusqu'à une reprise explicite, même après un redémarrage
  de LibreOffice. Faute de bandeau permanent, c'est le message de la fenêtre qui porte l'état.
- **Hors ligne, rien n'est perdu** : les mesures attendent dans une file et repartent.
- **L'extension n'emporte que la bibliothèque standard** de Python : aucune dépendance à
  installer, rien à compiler.

### Ce qu'elle ne fait pas, et c'est voulu

- Une sélection **tracée à la souris** n'est pas détectée : le gestionnaire de clic de
  LibreOffice ne donne pas de coordonnées. Tout le reste est mesuré comme dans le navigateur.
- Aucun texte ne quitte le poste.

### Nouveautés des boutiques

> **Français** — Certimens mesure votre façon de rédiger directement dans LibreOffice Writer et
> vous permet de rendre votre copie depuis le document. Aucun texte ne quitte votre ordinateur :
> seulement des compteurs.

> **English** — Certimens measures the way you write inside LibreOffice Writer and lets you hand
> in your copy from the document. No text ever leaves your computer: counters only.

## vscode 1.0.0

Première version de l'**extension Visual Studio Code**, paquet `.vsix`.

### Ce qu'elle fait

- **Mesure la rédaction fichier par fichier** : dans un éditeur de code, le devoir n'est pas un
  document mais un projet, et chaque fichier a sa propre histoire. Un document Certimens par
  fichier.
- **Ignore ce qui n'est pas écrit par l'étudiant** — `node_modules`, `.git`, les dossiers de
  construction — par un réglage qu'il peut étendre (`certimens.exclude`). Sans lui, un projet
  ordinaire créerait des centaines de documents.
- **Un panneau et une barre d'état** qui disent en permanence ce qui est mesuré, ce qui attend
  d'être envoyé, et si la mesure est suspendue.
- **La connexion se fait par un code**, confirmé dans l'espace Certimens — aucun mot de passe —
  et le jeton vit dans le coffre de l'éditeur (`SecretStorage`), pas dans un fichier de
  configuration.
- **La mesure se suspend** et le reste jusqu'à une reprise explicite, même après un redémarrage
  de l'éditeur.

### Ce qu'elle ne fait pas, et c'est voulu

- Pas de **nombre** de collages ni de reconnaissance d'un texte recollé : l'API donne le texte
  inséré et la *longueur* de ce qu'il remplace, jamais son contenu, et une insertion faite d'un
  coup peut être un collage, un extrait de code ou une complétion acceptée. Les caractères sont
  comptés, le nombre de collages serait faux ([`docs/mesures.md`](docs/mesures.md)).
- Aucun code, aucun texte ne quitte le poste.

### Nouveautés des boutiques

> **Français** — Certimens mesure votre façon de rédiger dans Visual Studio Code, fichier par
> fichier, en ignorant ce que vous n'avez pas écrit. Aucun code et aucun texte ne quittent votre
> ordinateur : seulement des compteurs.

> **English** — Certimens measures the way you write in Visual Studio Code, file by file,
> ignoring what you did not write yourself. No code and no text ever leave your computer:
> counters only.
