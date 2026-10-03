---
name: extension-libreoffice
description: Extension LibreOffice Writer en Python/PyUNO (libreoffice/, paquet .oxt) — composant UNO, Jobs.xcu/Addons.xcu, capteur clavier-souris, file hors-ligne et tests sans LibreOffice. À charger avant toute modification dans libreoffice/, et avant de diagnostiquer une extension qui ne démarre pas ou un LibreOffice qui se fige.
---

# Extension LibreOffice (PyUNO)

`libreoffice/` mesure la rédaction dans Writer. Contrairement au complément Word, LibreOffice
laisse écouter clavier et souris : **mêmes metrics et mêmes définitions que l'extension
navigateur** (voir la skill `mesures-redaction`).

## Ce qui compose le paquet

| Fichier | Rôle |
| --- | --- |
| `certimens.py` | composant UNO `fr.certimens.Agent` (`XJob`, `XJobExecutor`) |
| `Jobs.xcu` | démarre l'agent au lancement de LibreOffice (`onFirstVisibleTask`) |
| `Addons.xcu` | menu **Certimens** de Writer → `service:fr.certimens.Agent?open` |
| `description.xml` | gabarit : `{{VERSION}}` injecté par le build ; `identifier` **immuable** |
| `META-INF/manifest.xml` | déclare les trois fichiers ci-dessus au paquet |
| `pythonpath/certimens_agent/` | `measure.py`, `sensor.py`, `engine.py`, `agent.py`, `dialogs.py` |

LibreOffice ajoute `pythonpath/` à `sys.path` : d'où `from certimens_agent import …`. Un
fichier ajouté à la racine du paquet doit être déclaré dans `META-INF/manifest.xml`, sinon il
est simplement ignoré. L'identifiant `fr.certimens.agent` est publié sur
extensions.libreoffice.org : il ne change plus.

## Règles PyUNO

- **Rien ne doit remonter dans LibreOffice.** Une exception qui traverse un écouteur UNO peut
  emporter la session : les points d'entrée rattrapent
  (`except Exception as err: print('Certimens:', err)`).
- **Aucun réseau sur le fil de l'interface.** `engine.py` envoie depuis un fil dédié, et les
  fenêtres de `dialogs.py` appellent le moteur de la même façon : sinon LibreOffice reste figé le
  temps de la réponse.
- Les constantes UNO passent par `uno.getConstantByName('com.sun.star.awt.Key.…')`, jamais par
  une valeur numérique en dur.
- PyUNO expose un `char` UNO comme `uno.Char` (attribut `.value`), pas comme `str` : le lire
  directement lève `AttributeError` et perd la frappe (voir `key_char`).
- La répétition automatique se reconnaît côté X11 à une paire relâchement/appui de la même touche
  en moins de `AUTOREPEAT_MAX_S` ; `HELD_STALE_S` rattrape un relâchement manqué.
- Les collages sont vus **quelle que soit leur origine** (raccourci, menu, clic droit) en
  interceptant les commandes `.uno:Paste*`, pas en écoutant Ctrl+V.
- **Jamais de double tiret dans un commentaire XML du paquet.** XML l'interdit, et LibreOffice
  refuse le paquet **entier** : `unopkg add` répond qu'un commentaire ne doit pas en contenir, et
  l'extension ne s'installe pas du tout. Le build ne parse pas ces fichiers, il y substitue la
  version ; c'est `tests/test_package.py` qui les parse désormais, en millisecondes, plutôt que
  le conteneur de `make test-host` quelques minutes plus tard.
- L'identifiant du document vit dans ses **propriétés personnalisées** : il suit le fichier,
  `.odt` comme `.docx`.

## Testable sans LibreOffice

`measure.py` et `engine.py` **n'importent pas `uno`** — c'est délibéré, et c'est ce qui rend les
tests exécutables en CI. Toute logique de mesure ou d'envoi va dans ces deux modules ; `sensor.py`
et `dialogs.py` ne font que les câbler à LibreOffice. Introduire un `import uno` dans `measure.py`
ou `engine.py` casse `make -C libreoffice test`.

**Bibliothèque standard uniquement** : aucune dépendance tierce (`urllib.request`, pas
`requests`). C'est pourquoi Dependabot ne suit rien côté Python.

```bash
make -C libreoffice test    # python3 -m unittest discover -s tests
make -C libreoffice build   # dist/libreoffice.oxt
unopkg add libreoffice/dist/libreoffice.oxt   # puis redémarrer LibreOffice
```

Les tests sont en `unittest` (stdlib) et jouent des scénarios de frappe horodatés :
`libreoffice/tests/test_measure.py` vaut spécification des règles de comptage,
`test_engine.py` couvre la file hors-ligne.

## Diffusion et mise à jour

Le `.oxt` est joint à chaque release GitHub, puis **déposé à la main** sur
extensions.libreoffice.org : le site n'a pas d'API. Sous Linux, le paquet
`libreoffice-script-provider-python` de la distribution est nécessaire.

C'est le seul des quatre agents que **personne ne met à jour** — et extensions.libreoffice.org
n'y change rien, c'est un catalogue, pas un service de mise à jour. L'extension dit donc
elle-même où demander : `<update-information>` dans `description.xml` pointe
`https://certimens.github.io/plugins/libreoffice/update.xml`, et le gestionnaire d'extensions
compare, propose et installe. **Pas une ligne de code à nous dans ce chemin.**

Le flux est écrit par `build.py` (`make -C libreoffice feed`, ou `make build` sous un tag) et
déployé par la release. À ne pas casser :

- l'**adresse du flux est gelée** chez chaque étudiant installé, comme l'identifiant ;
- les `<dependencies>` du flux sont **recopiées de `description.xml`** : relever la version
  minimale de LibreOffice ne doit pas proposer une mise à jour à qui ne peut pas l'installer ;
- le flux ne connaît que des **tags** : un build de branche n'a pas de release, donc pas de
  `.oxt` à télécharger, et `build.py` refuse de l'annoncer ;
- **une release `libreoffice-v…` déploie GitHub Pages**, que le complément Word partage : un
  déploiement remplace le site entier (`docs/publication.md`, *Le site GitHub Pages*).

Une fois installée, la fenêtre Certimens dit la ligne « Certimens a été mis à jour » comme les
trois autres agents. Cet agent est le seul dont le code ne voit pas sa propre version : il la lit
dans le `description.xml` du paquet, deux dossiers au-dessus (`installed_version()`).

## Mesure suspendue

L'état vit dans `Engine.paused()` (donc dans `certimens.json`, partagé par tous les documents de
la session) et chaque `DocumentSensor` le consulte en tête de `on_key`, `on_click`, `on_paste` et
`on_deactivated`. Le bouton est dans la fenêtre **Certimens** (`dialogs.py`), qui vide la fenêtre
de mesure du document courant avant de suspendre. La règle commune est dans `mesures-redaction`.

## Langues

`pythonpath/certimens_agent/i18n.py` porte les textes des fenêtres et de la barre d'information ;
`description.xml` et `description/description-{fr,en}.txt` ceux du gestionnaire d'extensions. La
langue est choisie au démarrage de l'agent (`agent.py`) : celle du compte si l'étudiant est déjà
connecté, sinon `ooLocale` de LibreOffice. Les libellés du menu (`Addons.xcu`) n'ont rien à
traduire, ce sont des noms de marque. Règle complète : skill `langues-interface`.

## Ce que les tests ne voient pas

`make test` tourne **sans LibreOffice** : il remplace `uno` et les interfaces `com.sun.star.*`
par des objets à nous. C'est ce qui le rend instantané, et c'est le plafond. Un `.oxt` que
`unopkg` refuse, un composant que le bureau n'enregistre pas, un `from com.sun.star.X import Y`
qui n'existe pas dans cette version : tout cela passe les linters, passe les tests, et donne une
extension qui s'installe et ne fait rien.

`make -C libreoffice test-host` lance un **vrai LibreOffice** dans un conteneur jetable
(`tests/host/`) : le `.oxt` s'installe, le bureau liste l'extension et enregistre
`fr.certimens.Agent`, `XJob.execute` démarre l'agent comme au lancement, un document Writer
s'ouvre et s'écrit, puis l'extension se désinstalle. L'image se jette avec
`make test-host-clean`.

Deux limites, écrites aussi dans `libreoffice/TESTING.md` : le conteneur **n'a pas d'écran**, et
`XUserInputInterception` ne voit les frappes que dans une fenêtre affichée — aucune frappe n'est
donc mesurée là ; et la version testée est celle de Debian, pas la minimale de
`description.xml`. Le capteur et les fenêtres UNO restent à vérifier à la main.
