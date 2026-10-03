# Extension LibreOffice

Une extension **Writer** en Python (UNO) dans `libreoffice/`, paquet `libreoffice/dist/libreoffice.oxt`
(LibreOffice 7.0+ ; sous Linux, le paquet `libreoffice-script-provider-python` de la
distribution est nécessaire).

Contrairement au complément Word, LibreOffice laisse une extension écouter le clavier et la
souris d'un document : **mêmes mesures et mêmes définitions que l'extension navigateur**, flight
times, durées d'appui et sorties du document compris. Seule exception, son gestionnaire de clic ne donne pas de
coordonnées, donc une sélection tracée à la souris n'y est pas détectable
([mesures.md](mesures.md)).

## Les fichiers

- `certimens.py` : le composant UNO `fr.certimens.Agent`, démarré au lancement de LibreOffice
  (`Jobs.xcu`) et appelé par le menu **Certimens** de Writer (`Addons.xcu`).
- `pythonpath/certimens_agent/` :
  - `measure.py` : les fenêtres de mesure (la logique de `content.js`), sans LibreOffice ;
  - `sensor.py` : touches et clics du document (`XUserInputInterception`), collages de toute
    origine (commandes `.uno:Paste*` interceptées) et copies (`.uno:Copy`, `.uno:Cut`), dont
    l'empreinte sert à reconnaître un texte revenu d'un correcteur ([mesures.md](mesures.md)),
    sortie de LibreOffice, enregistrement ; une barre d'information propose d'associer un
    document encore inconnu ;
  - `engine.py` : moteur et file hors-ligne (`certimens.json` du profil LibreOffice, lisible par
    l'utilisateur seul), envoyée depuis un fil dédié, et les compteurs que l'agent tient sur
    lui-même ([plus bas](#ce-que-lagent-dit-de-lui-même)) ; pas de CORS, les appels partent de
    LibreOffice ;
  - `agent.py` : un agent par session, attaché à chaque document Writer ;
  - `dialogs.py` : les fenêtres du menu **Certimens** (l'équivalent de la popup de l'extension),
    construites contrôle par contrôle faute de HTML : appairage (un code court à recopier dans
    son espace Certimens — **aucun mot de passe n'est demandé**, voir
    [moteur.md](moteur.md#adresse-et-authentification)), puis document Certimens du
    document, devoir et envoi du .docx — ces trois derniers **désactivés** quand l'échéance du
    devoir est passée ([moteur.md](moteur.md)) : une fenêtre UNO place ses contrôles en absolu,
    donc ce qu'elle masque laisse son trou, et sa liste n'a pas de ligne désactivée — un devoir
    échu y est donc refusé au clic. UNO n'a pas non plus de `<details>` : l'adresse du moteur est
    révélée par une case **Paramètres avancés**, cochée d'avance quand l'adresse enregistrée
    n'est pas celle par défaut. Les appels au moteur partent d'un fil dédié — sinon LibreOffice
    resterait figé le temps de la réponse. Les deux fenêtres finissent par *Signaler un
    problème* ([plus bas](#signaler-un-problème)) ;
  - `i18n.py` : les deux dictionnaires d'interface ([langues.md](langues.md)) ;
  - `log.py` : `warn()`, ce que l'agent dit quand il rattrape une erreur. LibreOffice ne donne
    pas de console à une extension : le message part par `logging`, vers le terminal d'où
    LibreOffice a été lancé, et jamais avec ce que l'étudiant a écrit.
- `tests/` : `make -C libreoffice test`, sans LibreOffice. `test_sensor.py` tient, contre des
  doublures d'`uno`, les règles que `sensor.py` ajoute au câblage — quels relâchements sont
  chronométrés, quand une session recommence, quelle lecture du texte une fenêtre porte, à quel
  évènement un déplacement est réglé, sur quel fil une copie est hachée, ce que suit un
  *Enregistrer sous*. `test_dialogs.py` fait de même pour ce que `dialogs.py` porte de règles :
  la place du bouton *Signaler un problème*, l'adresse qu'il ouvre et comment, la lecture de la
  version de LibreOffice ([plus bas](#signaler-un-problème)).
  `test_package.py` y parse **tous les
  XML du paquet** : un commentaire portant un double tiret est interdit par XML et fait refuser
  le paquet entier par `unopkg`, ce que ni le build ni les linters ne voyaient — seul un vrai
  LibreOffice le disait, des minutes plus tard.

Chaque document garde son identifiant dans ses **propriétés personnalisées** (il suit le
fichier, `.odt` comme `.docx`).

**Après *Enregistrer sous*, le document continue dans le nouveau fichier.** Cette page promettait
deux choses qui se contredisaient : que le nom suit un *Enregistrer sous*, et qu'une version
enregistrée sous un autre nom reçoit une identité neuve. La règle tranche ainsi : le document
ouvert dans Writer est celui que l'étudiant continue d'écrire, il garde donc son identité et son
dossier. Sur `OnSaveAsDone` — que Writer lève après avoir déplacé le document, `make test-host`
le vérifie —, le capteur relit l'adresse du fichier, le lien du dossier est rattaché au nouveau
fichier (`Engine.rebind`), les fenêtres encore en file le suivent, et le dossier prend le nouveau
nom. **La version enregistrée sous un autre nom, c'est le fichier laissé derrière** : il porte
toujours la même identité, et le contrôle du lien ci-dessous la lui refuse à sa prochaine
ouverture — il reçoit une identité neuve et l'invite de liaison. Auparavant, l'adresse n'était
lue qu'à l'ouverture : les fenêtres écrites après l'enregistrement restaient liées à l'ancien
fichier, et la réouverture du nouveau, trouvant l'ancien encore sur le disque, scindait le
dossier en deux. *Enregistrer une copie* et l'envoi du `.docx` (`storeToURL`) ne déplacent pas le
document ouvert : c'est la copie qui, rouverte, reçoit une identité neuve.

Le rattachement ne prend que le verrou de l'état, sans réseau, donc il se fait sur le fil de
l'interface. Trois endroits nomment le fichier et tous trois suivent : le lien d'un document
Certimens qui existe ; les fenêtres en file, d'où un document pas encore créé prendra son
fichier ; et, pour une création déjà en vol qui a lu l'ancien fichier en tête de file,
`Engine.moved`, qu'elle enregistre à la place.

L'identifiant voyage **dans le fichier**, donc ce qu'il contient a été écrit par qui a produit ou
détenu ce fichier — personne la plupart du temps, un tiers parfois. Deux contrôles le séparent du
document Certimens qu'il désigne :

- **la forme** : une valeur que l'agent n'aurait pas pu frapper lui-même n'est pas adoptée, elle
  est remplacée. Cela écarte aussi bien une chaîne fabriquée qu'une propriété vide, fausse ou
  d'un autre type, qui donnait une identité inutilisable et jamais réparable — toutes les
  fenêtres de ce document étaient alors jetées en silence, pour la vie du fichier ;
- **le lien** : une entrée créée pour un fichier n'accueille pas un autre fichier. Une simple
  copie du document de l'étudiant porte la même identité, sans attaquant nulle part : un double
  gardé à côté de l'original, un brouillon qu'un correcteur a renvoyé, le fichier qu'un *Enregistrer sous* a laissé derrière lui. Sans ce contrôle, les frappes du second fichier étaient fusionnées dans
  le dossier du premier, le dossier était renommé d'après le dernier fichier touché, et le dépôt
  y remplaçait le contenu par le mauvais fichier. Le second fichier reçoit une identité neuve, et
  l'étudiant retrouve l'invite de liaison que ce chemin sautait.

Le moteur ne peut pas voir la collision — la création ne porte qu'un nom, l'identité locale ne
traverse jamais le réseau — donc le refus vit dans l'agent, **avant** l'adoption. L'emplacement
du fichier est enregistré à côté du document Certimens ; un renommage ou un déplacement ne scinde
pas le dossier, il rattache l'emplacement.

## La fenêtre envoyée

L'extension envoie le corps unique du protocole ([moteur.md](moteur.md)) : des fenêtres
numérotées dans une session, faites du **déroulé** des gestes (`runs`), de ce que seul le capteur
sait classer (`counts`), du **rythme** (`flight`, `dwell`), de la **portée du texte** (`text`) et
des cumuls de la session (`sum`). [mesures.md](mesures.md) en donne les définitions, communes aux
quatre agents ; ce qui suit est ce qui est propre à celui-ci.

Rien de ce que le moteur déduit du déroulé n'est envoyé : ni le nombre de frappes, ni celui des
collages, ni les caractères injectés, ni les restitutions, ni les hésitations, ni les pauses.
`measure.py` ne tient plus les bornes d'une hésitation ou d'une pause ; il garde une seule règle
de comptage qui est aussi celle du moteur, `INJECTION_MIN_CHARS`, parce que le cumul des
caractères injectés (`sum.chars`) en dépend.

| Bloc | Ce que l'extension envoie |
| --- | --- |
| `runs` | toujours, jamais vide — `type`, `erase`, `nav`, `other`, `click`, `paste`, `self`, `copy`, `undo`, `gap` ; jamais `move` ni `fix` |
| `counts` | les sept clés : `corrections`, `reformulations`, `revisions`, `jumps`, `exits`, `back_keys`, `back_chars` |
| `flight` | dès que la fenêtre porte deux écarts de moins de `FLIGHT_MAX_MS` ; omis sinon |
| `dwell` | toujours, zéros compris (`{"bins":[],"rollover":0}` pour une fenêtre sans frappe chronométrée) |
| `text` | `{len}` dès que le compte de Writer est connu, avec la portée quand elle peut être dite (voir plus bas) |
| `sum` | toujours : `keys`, `chars`, `pastes` |
| `unseen` | jamais : ce capteur voit les silences courts |

**La session.** `measure.py` la tient : un identifiant tiré par `secrets.token_urlsafe`
(`SESSION_ID_BYTES`), le numéro de la prochaine fenêtre, les cumuls, et le zéro de l'horloge
monotone (`time.monotonic()`). Elle s'ouvre à l'ouverture du document si la mesure est active,
sinon au premier geste compté ; elle se ferme quand la fenêtre est scellée pour `end` —
suspension, déconnexion, fermeture du document. Un capteur n'est prévenu ni d'une suspension
levée ni d'un nouvel appairage faits depuis la fenêtre d'un **autre** document : il lit
`Engine.epoch`, un compteur que ces trois gestes font avancer, en tête de chaque gestionnaire,
et ce qu'il compte ensuite ouvre une session neuve. Numéro et cumuls avancent dans
`Measure.take()`, l'opération qui scelle : une fenêtre scellée qui ne part jamais — document
sans identité, file pleine — est quand même comptée.

**Les horloges.** L'heure du poste (`time.time()`) ne donne que deux choses : `at`, la date de
la première activité de la fenêtre, et `sent`, la date de l'envoi. **Toute durée est mesurée sur
l'horloge monotone** (`time.monotonic()`) : `mono` (compté depuis le début de la session), `ms`
(de la première à la dernière activité, au moins 1 000), `active`, la durée de chaque suite et de
chaque silence, les écarts de `flight` et les appuis de `dwell`. `sensor.py` lit cette horloge à
chaque événement et ne passe rien d'autre à `measure.py` : une heure changée au milieu d'une
phrase ne fabrique ni silence ni frappe instantanée, elle ne déplace que `at` — ce que le moteur
lit justement en le comparant à `mono`. Tous ces nombres partent en entiers de millisecondes,
sauf `flight.med` et `flight.mad`, à deux décimales.

**Le déroulé.** Le genre d'une suite est la catégorie que `sensor.py` donne déjà à la touche,
rien de plus fin : `erase`, `nav`, et pour tout le reste `type`, ou `other` quand Ctrl/Cmd en
fait un raccourci. `measure.py` ne reçoit jamais le caractère. Ctrl+Alt ensemble, qui est AltGr
sous Windows, reste `type`. Un collage est une suite `paste` par geste, une restitution une suite
`self` — précédée de la frappe qu'elle vaut, une suite `other` sans durée. L'extension n'émet
jamais `fix` (elle ne voit pas une orthographe choisie dans le correcteur) ni `move` (tout
déplacement qu'elle voit est une touche ou un clic).

**Aller à la fin du texte n'est pas y revenir** ([mesures.md](mesures.md), *Règles de
comptage*). Un déplacement — flèche, Début/Fin, page, avec ou sans Ctrl, ou un clic — qui laisse
le curseur **à la fin du texte** ne compte ni `counts.jumps` ni trajet (`nav_steps` à zéro), et
ce qui est tapé ensuite n'est pas une reformulation. Le geste reste dans le déroulé : la suite
`nav` ou `click` est écrite, et une touche de navigation reste une frappe comptée.

La difficulté tient à LibreOffice : **la touche et le clic arrivent à leur gestionnaire avant que
le curseur bouge**. `make test-host` le montre dans un vrai Writer : un `XKeyHandler` qui lit le
curseur dans `keyPressed` de Ctrl+End le trouve encore à sa place, et c'est seulement après que
Writer l'a posé à la fin. L'écouteur de sélection (`XSelectionChangeListener`) arrive bien après
le déplacement, mais il se déclenche à chaque caractère tapé, parfois deux fois pour un seul
déplacement dont la première encore à l'ancienne position. Le capteur fait donc autrement : le
déplacement est écrit au moment où il a lieu et laissé **en attente** (`Measure.pending_move`),
puis **réglé à l'évènement suivant** — touche, clic, copie, collage ou scellement de la fenêtre —,
qui trouve le curseur là où le déplacement l'a laissé (`Measure.settle_move`). Une répétition
automatique ne règle rien : la flèche maintenue est réglée à la touche suivante, une fois
arrivée. Un déplacement avec Maj (une sélection) est compté tout de suite et n'attend jamais :
sélectionner depuis la fin vers le haut reste un déplacement. Un déplacement qui scelle lui-même
la fenêtre (`volume`) ne peut pas attendre et est compté comme avant ; personne n'ayant lu le
curseur, c'est la règle par défaut — elle ne peut que retirer des sauts, jamais en ajouter. Et
rien d'un déplacement en attente ne survit à la fin d'une session.

« La fin du texte », pour Writer (`caret_at_end`) : un curseur sans sélection, **dans le corps du
document**, après lequel ne viennent que des blancs — des espaces, et au plus `END_PARAGRAPHS`
(trois) paragraphes vides, la façon dont un document se termine le plus souvent. La fin exacte
coûte une comparaison de deux plages (`compareRegionEnds`) ; en deçà, ce qui est lu est la fin
du paragraphe du curseur et au plus trois paragraphes après lui, **jamais le document**, et une
fois par déplacement. Un curseur dans une cellule de tableau, une note, un cadre ou un en-tête
n'est pas dans le corps : la réponse y est « pas à la fin », comme pour un tableau qui suit le
curseur (c'est du contenu, même vide), et comme pour tout ce que UNO refuse de dire — jamais une
exception. La lecture se fait **hors du verrou du capteur** : un scellement sur le fil d'un
minuteur attend le verrou de LibreOffice pour lire le curseur, que le fil de l'interface tient
pendant qu'il attend le nôtre. Elle est rendue avec le déplacement pour lequel elle a été faite,
et une lecture dépassée par un autre déplacement ne règle rien.

**Les copies.** Une copie est lue sur le fil de l'interface, avant que la commande s'exécute —
une coupe ne laisse rien derrière elle — et sa suite `copy` est écrite aussitôt
(`Measure.take_copy`). Ses empreintes non : un hachage par mot de la sélection, c'est environ
0,15 s pour Ctrl+A, Ctrl+C sur une dissertation sur un poste de développement, trois à cinq fois
plus sur celui d'un étudiant, et LibreOffice resterait figé autant. Elles sont calculées sur un
fil à part et rangées sous le verrou du capteur (`Measure.hash_copy`). Un collage arrivé avant la
fin du calcul ne manque pas la copie et ne la compare pas à moitié faite : il calcule lui-même
les empreintes en attente, et le fil qui s'en chargeait trouve le travail fait. Le texte copié
reste en mémoire le temps de ce calcul, et pas plus. Les valeurs des empreintes ne changent pas :
c'est un contrat entre les quatre agents.

**Les silences.** `["gap", ms]` pour tout silence d'au moins `GAP_MIN_MS` (1 000 ms) entre deux
frappes comptées, à sa durée réelle arrondie à la milliseconde, sans plafond. Un clic, un
collage et la touche de collage ne terminent ni ne commencent un silence. LibreOffice ne signale
pas de composition (palette d'accents, IME) à un `XKeyHandler` : l'exception que le protocole
prévoit pour elle n'a pas lieu de s'appliquer ici. **Un silence ne traverse jamais une session** :
il se mesure depuis la dernière frappe comptée de la session en cours, et l'horloge des silences
repart de zéro quand une session s'ouvre (`Measure.start_session()`). La première fenêtre d'une
session ne s'ouvre donc par aucun silence — pas par celui qu'a duré une suspension.

**Le déroulé n'est jamais amputé.** Une fenêtre est scellée (`volume`) à
`TIMELINE_MAX_RUNS − TIMELINE_HEADROOM` suites (504), **quoi qu'elle contienne** : aucune suite
n'est jetée pour tenir sous le plafond. Des clics et des copies seuls ne valent pas une fenêtre —
leurs suites partent avec la suivante — sauf dans ce cas, où la fenêtre part sans frappe ni
collage, scellée par le clic ou la copie qui l'a remplie.

**Le rythme.** `XKeyHandler` donne `keyReleased` : `dwell` est envoyé à chaque fenêtre. Les
histogrammes partent sans leurs zéros de queue. Trois précautions tiennent à ce que LibreOffice
livre réellement :

- pendant une répétition automatique, X11 envoie un relâchement avant chaque appui répété. Un
  relâchement n'est donc compté qu'à l'événement clavier **suivant** (ou au scellement) : si
  c'est la même touche qui revient en répétition, elle n'avait pas été relâchée ;
- un relâchement peut manquer — une fenêtre de dialogue ouverte à l'appui, un changement
  d'application touche enfoncée. La touche n'est alors chronométrée nulle part, et
  `HELD_KEYS_MAX` (dix) borne ce qui est suivi ;
- les touches **sans code UNO** — un `é` ou un `ç` d'un clavier français — partagent le code 0 :
  leur relâchement ne peut pas être apparié à leur appui, et elles ne sont pas chronométrées.
  Elles comptent dans `type` comme les autres ; `dwell` porte donc moins de valeurs que la
  fenêtre n'a de frappes `type`, ce que le contrat admet.

Un relâchement qui arrive après le scellement de la fenêtre où l'appui a été compté n'est
chronométré nulle part : une fenêtre ne porte jamais plus d'appuis que de frappes `type`.

**Le texte.** `text.len` est le `CharacterCount` de Writer, lu au plus toutes les
`VOLUME_REFRESH_S` ; le corps du texte (`getText().getString()`, sauts de paragraphe et de ligne
retirés) est lu **au même moment, jamais plus souvent**, et comparé à la lecture précédente quand
la fenêtre est scellée. Les deux ne comptent pas toujours la même chose : le compte de Writer
prend aussi ce que le corps ne contient pas — une note de bas de page, un cadre, l'étiquette
d'une liste numérotée. La règle qui dit quand le corps lu peut être cru n'a pas changé : **une
portée n'est dite que d'une lecture dont la longueur est exactement le compte envoyé**. Ce que
devient le bloc, cas par cas :

| Situation | `text` |
| --- | --- |
| lecture neuve, de la longueur du compte, qui en suit une autre dans la session | `{len, since, at, cut, add, kept?}` — y compris identique à la précédente (`cut` et `add` à 0) |
| première lecture de la session | `{len}` ; elle devient la référence de la portée suivante |
| compte repris du cache (moins de `VOLUME_REFRESH_S` depuis la lecture) | `{len}` |
| lecture dont la longueur **n'est pas** le compte (note, cadre, liste numérotée) | `{len}` seul, avec le compte de Writer ; la lecture est écartée et la **référence reste la dernière lecture crue** — la portée suivante se mesure depuis elle, et son `since` désigne la fenêtre qui la portait |
| corps illisible (le pont UNO ne répond plus) alors que le compte l'est | `{len}` |
| compte jamais lu | bloc **omis** |

Sur un mémoire qui porte des notes de bas de page, le compte et le corps diffèrent à chaque
lecture : l'extension n'y envoie donc **jamais de portée**, seulement la taille. `make test-host`
vérifie l'égalité dans un vrai Writer, sur des paragraphes simples.

`kept` est calculé par `difflib.SequenceMatcher` sur les deux côtés découpés en mots. Ses blocs
communs sont une sous-suite commune, pas toujours la plus longue : ce qu'ils manquent compte
comme du texte neuf, jamais l'inverse. Outre la borne commune de 2 000 mots, le calcul est
abandonné au-delà de `TEXT_KEPT_MAX_PAIRS` (25 000) paires de mots égaux entre les deux côtés,
qui est ce qu'il coûte : une prose ordinaire l'atteint vers mille mots par côté. Mesuré sur un
poste de développement : 5 à 10 ms à cette borne, contre 600 ms sans elle pour deux mille mots
identiques — sur le fil qui scelle la fenêtre. Au-delà, `kept` est omis.

La lecture précédente vit dans `Measure.previous_text`, en mémoire vive, et est lâchée quand la
session se ferme.

**L'envoi.** `Measure.take()` rend la fenêtre telle qu'elle partira, et `engine.py` la met en
file avec sa session — rien d'autre de la session n'est écrit. Seul `offline` s'y ajoute, à la
mise en file, quand la dernière tentative d'envoi avait échoué. À l'envoi, `wire_window()`
reconstruit chaque niveau clé par clé, dans l'ordre du protocole (la file est relue du profil,
dans l'ordre du fichier), et le corps est écrit sans espace (`separators=(',', ':')`) ; `sent`
est l'heure du poste en millisecondes, réécrite à chaque tentative. Une fenêtre en direct part
seule ; une file qui a attendu hors ligne part par lots de `BATCH_MAX_WINDOWS` fenêtres
**consécutives** d'un même document et d'une même session, toutes marquées `offline` ; un lot
refusé (`400`, `409`) est renvoyé fenêtre par fenêtre, pour ne perdre que celle que le moteur
refuse.

**Il n'y a qu'un corps.** Un `400` ou un `409` abandonne la fenêtre, quel que soit son code :
l'agent ne la renvoie sous aucune autre forme et n'en retire rien pour un moteur plus ancien. Une
entrée de la file qui n'a pas cette forme — le profil d'une autre version de l'extension, un
fichier modifié à la main — est **jetée à la lecture du profil**, jamais convertie ; et
`Engine.enqueue()` refuse une fenêtre qui ne l'a pas.

## Reprendre un document d'un éditeur à l'autre

Un mémoire commencé dans Word et poursuivi dans Writer est **un seul travail**, et doit rester un
seul dossier côté moteur. Ce qui le permet tient dans deux propriétés personnalisées, écrites
dans le fichier lui-même — `.odt` comme `.docx` — et lues sous le même nom par les deux agents :

| Propriété | Ce qu'elle porte |
| --- | --- |
| `CertimensDocumentId` | l'identité locale du document, qui ne traverse jamais le réseau |
| `CertimensEngineDocument` | le document Certimens que ce fichier alimente |

La seconde est écrite une fois le document Certimens créé, jamais avant : un identifiant inscrit
pour un document qui n'existe pas enverrait l'éditeur suivant chercher le vide. À l'ouverture
d'un fichier qui la porte, l'agent **reprend** ce document au lieu d'en ouvrir un second — en
silence, sans rien demander à l'étudiant, parce que c'est le comportement qu'il attend et que la
question se poserait à chaque ouverture.

C'est la seule valeur que ces agents lisent **dans un fichier**, donc la seule dont personne
n'a vérifié la forme avant eux. Quatre refus la séparent du document qu'elle désigne :

- **la forme**, vérifiée à l'entrée et non à l'usage (`^[A-Za-z0-9_-]{1,64}$`, le même motif dans
  les trois agents qui en lisent un, comparé par `make check`) : une barre oblique ou un `..`
  dedans n'est plus un identifiant, c'est une autre route, appelée avec un jeton qui n'expire
  pas ;
- **le propriétaire** : le moteur répond `404` ou `403` pour un document qui n'est pas à ce
  compte, et c'est là toute l'autorisation — seul le propriétaire d'un document y écrit. Le
  fichier qu'un camarade envoie est donc un fichier comme un autre, qui reçoit son propre
  dossier ;
- **le rôle** : seul un `student` reprend. Un enseignant a le droit de lire la copie qu'on lui a
  rendue, donc le moteur répondrait `200` — et ses propres frappes iraient grossir le dossier de
  son étudiant ;
- **le double** : c'est le refus qui vit ici et nulle part ailleurs. Si l'identité du fichier est
  déjà liée à un autre fichier sur ce poste, celui-ci est une copie — le moteur ne peut pas les
  distinguer, les deux sont de cet étudiant — et rien de ce qu'elle nomme n'est repris.

Un fichier ouvert sur une autre machine, lui, est indiscernable d'une reprise légitime : c'est
exactement le signal qu'on a choisi de croire.

La reprise est un appel réseau, donc elle ne retarde rien : la mesure démarre tout de suite, les
fenêtres s'empilent dans la file sous l'identité locale, et le document Certimens n'est résolu
qu'à l'envoi. Une fenêtre mesurée pendant que la reprise est en vol rejoint le document repris
plutôt que d'en ouvrir un second à côté.

La reprise se voit : une barre d'information dit quel document Certimens ce fichier poursuit, à
la place de l'invite de liaison, qui n'a plus rien à proposer.

**Elle est demandée deux fois plutôt qu'une.** À l'ouverture du fichier, pour la barre
d'information ; et de nouveau **au moment où un document serait créé** (`Engine._ensure_document`),
parce que la première peut ne pas avoir eu lieu : personne n'était encore connecté (le fichier
ouvert sur la machine de la maison *avant* l'appairage), ou le moteur était hors d'atteinte. Le
capteur confie donc au client l'identifiant que le fichier porte (`Engine.carry`), et le client
pose la question avant de créer. Une reprise restée sans réponse n'a rien décidé : rien n'est
créé à sa place, la fenêtre attend. Sans cela, la première fenêtre ouvrait un second dossier,
et le fichier était ré-estampillé avec lui — la scission devenait définitive.


## Envoyer le document

Le bouton *Envoyer le document* exporte le document ouvert au format .docx par le filtre Word de
Writer (`storeToURL`, une copie : le document garde son URL, son format et son état enregistré)
et l'envoie au document Certimens.

Si cet export est refusé (filtre absent de l'installation, dossier temporaire en lecture seule),
la fenêtre affiche à la place *Choisir un fichier .docx…*, comme la popup le fait pour Word
Online : l'étudiant enregistre lui-même une copie .docx et la désigne. Dans les deux cas, un
nouvel envoi remplace le document déjà envoyé, et le moteur plafonne la requête à 25 Mio (soit
18 Mo de document).

## Ce que l'agent dit de lui-même

Comme les trois autres, l'extension compte ce qui lui arrive — installation, mise à jour,
démarrage, erreurs, échecs réseau, fenêtres que la file pleine a dû lâcher — et envoie ces
compteurs au moteur, au plus tous les quarts d'heure, une fois appairée. Le vocabulaire, le
plafond, la fréquence et ce qui remet à zéro sont le contrat de
[moteur.md](moteur.md#ce-que-lagent-dit-de-lui-même) ; ce qui est propre à cet agent :

- **où ils vivent** : dans `certimens.json`, à côté de la file, donc sous la même règle `0o600`.
  Un compte s'ajoute en mémoire et s'écrit avec l'état suivant, que la boucle d'envoi écrit de
  toute façon chaque minute (son statut) : une écriture par compte remettrait tout l'état sur le
  disque à chaque frappe qui échoue. Ce que cela coûte : la dernière minute de comptes si
  LibreOffice est tué. L'heure du dernier envoi est dans le même fichier, si bien qu'un
  redémarrage ne contourne pas le quart d'heure ;
- **`error.runtime` sans `sys.excepthook`** : LibreOffice fait tourner toutes les extensions
  Python dans un seul interpréteur, ce crochet-là — comme `threading.excepthook` — appartient à
  toutes. L'agent compte donc là où **ses propres** points d'entrée rattrapent : écouteurs UNO
  (touches, clics, collages, focus, évènements du document), `execute` et `trigger` du
  composant, boutons et fils des fenêtres, minuteurs et fils du capteur, fil d'envoi. Une
  exception d'une autre extension n'y passe jamais ;
- **où son code a échoué** : chaque `error.runtime` garde aussi l'endroit (`fault_of`), tiré de
  la trace Python (`traceback.extract_tb`), de la frame la plus interne à la plus externe, au
  plus douze : `fonction@fichier.py:ligne`, sans colonne, que Python ne donne pas. Seules les
  frames des fichiers de l'extension restent — le paquet `certimens_agent/` et `certimens.py` —
  sous leur **nom nu** : le chemin d'une extension installée passe par le profil, donc par le nom
  du compte de l'utilisateur. La bibliothèque standard, le Python de LibreOffice et les autres
  extensions n'y figurent jamais, et le message de l'exception non plus. Au plus dix erreurs
  distinctes, chacune avec son nombre, attendent l'envoi dans `certimens.json` (`telemetryFaults`
  du contrat, ici sous `telemetry.faults`) ; relues depuis le fichier, seules celles qui ont
  exactement cette forme sont gardées ;
- **`installed` et `updated`** comparent la version du paquet (`installed_version()`) à celle
  que le profil a retenue pour ces compteurs. Un profil d'avant ces compteurs n'en a pas, mais
  peut connaître la version que la ligne « Certimens a été mis à jour » a vue en dernier : c'est
  alors une mise à jour, pas une installation. Un checkout n'a pas de version et ne dit ni l'un
  ni l'autre ; `started` vaut **un chargement par session LibreOffice**, quel que soit le nombre
  de documents ouverts ;
- **ce qui n'est pas une erreur** : pendant l'appairage, « personne n'a encore confirmé » et
  « demandé trop souvent » (`429` compris) disent d'attendre, et la reprise d'un document lit
  `403` et `404` comme « rien à reprendre » ([plus haut](#reprendre-un-document-dun-éditeur-à-lautre)).
  Ces réponses-là ne sont pas comptées ; tout autre refus du moteur l'est.

## Signaler un problème

Le lien, le bloc et ce qui n'y figure jamais sont le contrat de
[moteur.md](moteur.md#signaler-un-problème) ; ce qui est propre à cet agent :

- **où est le bouton** : *Signaler un problème*, en bas des **deux** fenêtres (connexion et
  document), juste **sous la ligne de message**. C'est là que la fenêtre dit ce qui a échoué —
  un appairage refusé, un moteur injoignable, un envoi rejeté —, si bien que le moyen de le
  signaler est la ligne suivante, quelle que soit la disposition du dessus. Une fenêtre UNO se
  dispose en positions absolues : un bouton qui n'apparaîtrait qu'avec une erreur laisserait sa
  place vide le reste du temps, ou décalerait tout. Il n'est **pas bloquant** — il n'appelle
  pas le moteur, il ouvre le navigateur —, et reste donc actif pendant un appel, y compris un
  appairage qui n'en finit pas. Son aide au survol (`HelpText`) dit ce qui part, comme celles
  des autres boutons ;
- **comment il ouvre** : `SystemShellExecute` avec `URIS_ONLY`, comme *Ouvrir dans Certimens* et
  les notes de release — le système ouvre une adresse, jamais un programme. Le lien est fabriqué
  par `Engine.report_url` (`engine.py`, sans `uno`) ; les constantes `REPORT_FRAGMENT` et
  `REPORT_KEYS` sont comparées aux trois autres agents par `make check` ;
- **`host`** : `LibreOffice` suivi de la version de la boîte *À propos* (`ooSetupVersionAboutBox`,
  à défaut `ooSetupVersion`, sous `/org.openoffice.Setup/Product`), lue par la fenêtre
  (`dialogs.office_version`) et passée au moteur client : `engine.py` reste sans `uno`. Illisible,
  la ligne dit `unknown`. `make test-host` vérifie qu'un vrai LibreOffice la donne ;
- **`os`** : `platform.system()` et `platform.machine()` (`Linux x86_64`, `Darwin arm64`,
  `Windows AMD64`) ;
- **`status`** : le mot que l'agent a écrit dans `certimens.json` (`idle`, `synced`, `offline`,
  `auth_error`, `unconfigured`), suivi de `(reached)` ou `(unreachable)` pour `offline`. Le
  fichier est à l'étudiant : un autre mot y devient `unknown` ;
- **`counters`** : les compteurs de la section précédente pas encore partis, dans l'ordre du
  vocabulaire (`none` s'il n'y en a pas) ;
- **`engine`** : l'origine seule (schéma, hôte, port) — ni chemin ni identifiants écrits dans
  l'adresse. **Depuis la fenêtre de connexion**, c'est l'adresse saisie dans *Paramètres avancés*
  qui compte, avant même d'être enregistrée : un appairage qui échoue contre le moteur d'un
  établissement se signale à ce moteur-là. Refusée (`engine_url_allowed`), elle cède la place
  au moteur par défaut, pour l'adresse du lien comme pour la ligne.

Lire l'état pour le bloc n'écrit rien et n'appelle rien : la fenêtre peut le faire sur le fil
de l'interface.

## Installer

*Outils › Gestionnaire des extensions › Ajouter* → `libreoffice.oxt`, puis redémarrer
LibreOffice. En ligne de commande :

```bash
unopkg add dist/libreoffice.oxt
```

## Mettre à jour une extension déjà installée

C'est le seul des quatre agents que **personne ne met à jour**. Un navigateur met à jour ses
extensions, le Marketplace les siennes, et le volet Word est repris du site à chaque ouverture ;
un `.oxt` installé, lui, ne sait rien — et extensions.libreoffice.org n'y change rien : le site
est un catalogue, il ne sert aucun flux de mise à jour, et c'est à l'extension de dire où
demander.

Elle le dit dans `description.xml`, par un `<update-information>` qui pointe
`https://certimens.github.io/plugins/libreoffice/update.xml`. Le gestionnaire d'extensions
compare, propose, télécharge et installe : **il n'y a pas une ligne de code à nous dans ce
chemin**, rien à traduire, aucun appel sur le fil de l'étudiant.

Le flux est écrit par `build.py` (`make -C libreoffice feed`, ou `make build` quand un tag le
nomme) et déployé sur GitHub Pages par la release. Il porte l'identifiant et les
`<dependencies>` **recopiés de `description.xml`** — une version qui relèverait la version
minimale de LibreOffice ne doit pas être proposée à qui ne peut pas l'installer —, la dernière
version taguée, un lien vers les notes de la release et l'adresse du `.oxt` de cette release.

Deux conséquences à connaître :

- **l'adresse du flux est gelée** chez chaque étudiant installé, comme l'identifiant : ce qui
  est publié là doit le rester ;
- le flux ne connaît que des **tags**. Un build de branche (`1.4.2-a9085f3`) n'a pas de release,
  donc pas de `.oxt` à télécharger : `build.py` refuse de l'annoncer, et un dépôt sans tag
  n'écrit pas de flux du tout.

Le site Pages porte donc deux choses, et **un déploiement remplace tout le site** : voir
[publication.md](publication.md#le-site-github-pages).

### Une fois installée

La fenêtre **Certimens** dit alors la même ligne que les trois autres agents, avec un bouton
vers les notes de release : le gestionnaire d'extensions a montré celles-ci pendant la mise à
jour et ne les remontrera jamais. La règle est écrite une fois :
[extension-navigateur.md](extension-navigateur.md#certimens-a-été-mis-à-jour).

C'est le seul des quatre agents dont le code ne voit pas sa propre version : il la lit dans le
`description.xml` du paquet, deux dossiers au-dessus de lui (`installed_version()`). Depuis un
checkout, ce manifest porte encore `{{VERSION}}` — un gabarit n'est pas une version, et rien
n'est annoncé.

## Publier

[extensions.libreoffice.org](https://extensions.libreoffice.org) n'a pas d'API : déposer à la
main le `.oxt` de chaque release GitHub (`certimens-libreoffice-X.Y.Z.oxt`). L'identifiant
`fr.certimens.agent` (`description.xml`) ne doit plus changer.

Ce dépôt-là ne conditionne plus les mises à jour : le flux ci-dessus les sert depuis la release,
le jour où elle est publiée. La fiche du site reste ce qui fait **découvrir** l'extension.
