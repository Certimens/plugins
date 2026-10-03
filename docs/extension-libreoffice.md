# Extension LibreOffice

Une extension **Writer** en Python (UNO) dans `libreoffice/`, paquet `libreoffice/dist/libreoffice.oxt`
(LibreOffice 7.0+ ; sous Linux, le paquet `libreoffice-script-provider-python` de la
distribution est nécessaire).

Contrairement au complément Word, LibreOffice laisse une extension écouter le clavier et la
souris d'un document : **mêmes metrics et mêmes définitions que l'extension navigateur**, flight
times et sorties du document compris. Seule exception, son gestionnaire de clic ne donne pas de
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
    l'utilisateur seul), envoyée depuis un fil dédié ; pas de CORS, les appels partent de
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
    resterait figé le temps de la réponse ;
  - `i18n.py` : les deux dictionnaires d'interface ([langues.md](langues.md)) ;
  - `log.py` : `warn()`, ce que l'agent dit quand il rattrape une erreur. LibreOffice ne donne
    pas de console à une extension : le message part par `logging`, vers le terminal d'où
    LibreOffice a été lancé, et jamais avec ce que l'étudiant a écrit.
- `tests/` : `make -C libreoffice test`, sans LibreOffice. `test_package.py` y parse **tous les
  XML du paquet** : un commentaire portant un double tiret est interdit par XML et fait refuser
  le paquet entier par `unopkg`, ce que ni le build ni les linters ne voyaient — seul un vrai
  LibreOffice le disait, des minutes plus tard.

Chaque document garde son identifiant dans ses **propriétés personnalisées** (il suit le
fichier, `.odt` comme `.docx`) ; le nom du fichier est répercuté sur le moteur après
*Enregistrer sous*.

## Envoyer le document

Le bouton *Envoyer le document* exporte le document ouvert au format .docx par le filtre Word de
Writer (`storeToURL`, une copie : le document garde son URL, son format et son état enregistré)
et l'envoie au document Certimens.

Si cet export est refusé (filtre absent de l'installation, dossier temporaire en lecture seule),
la fenêtre affiche à la place *Choisir un fichier .docx…*, comme la popup le fait pour Word
Online : l'étudiant enregistre lui-même une copie .docx et la désigne. Dans les deux cas, un
nouvel envoi remplace le document déjà envoyé, et le moteur plafonne la requête à 25 Mio (soit
18 Mo de document).

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
main le `.oxt` de chaque release GitHub (`certimens-agent-X.Y.Z-libreoffice.oxt`). L'identifiant
`fr.certimens.agent` (`description.xml`) ne doit plus changer.

Ce dépôt-là ne conditionne plus les mises à jour : le flux ci-dessus les sert depuis la release,
le jour où elle est publiée. La fiche du site reste ce qui fait **découvrir** l'extension.
