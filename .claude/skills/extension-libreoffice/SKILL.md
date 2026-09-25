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
  emporter la session : les points d'entrée rattrapent (`except Exception as err: print('Certimens:', err)`).
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
- L'identifiant du document vit dans ses **propriétés personnalisées** : il suit le fichier,
  `.odt` comme `.docx`.

## Testable sans LibreOffice

`measure.py` et `engine.py` **n'importent pas `uno`** — c'est délibéré, et c'est ce qui rend les
tests exécutables en CI. Toute logique de mesure ou d'envoi va dans ces deux modules ; `sensor.py`
et `dialogs.py` ne font que les câbler à LibreOffice. Introduire un `import uno` dans `measure.py`
ou `engine.py` casse `npm run test:libreoffice`.

**Bibliothèque standard uniquement** : aucune dépendance tierce (`urllib.request`, pas
`requests`). C'est pourquoi Dependabot ne suit rien côté Python.

```bash
npm run test:libreoffice   # python3 -m unittest discover -s libreoffice/tests
npm run build              # dist/libreoffice.oxt
unopkg add dist/libreoffice.oxt   # puis redémarrer LibreOffice
```

Les tests sont en `unittest` (stdlib) et jouent des scénarios de frappe horodatés :
`libreoffice/tests/test_measure.py` vaut spécification des règles de comptage,
`test_engine.py` couvre la file hors-ligne.

## Diffusion

Le `.oxt` est joint à chaque release GitHub, puis **déposé à la main** sur
extensions.libreoffice.org : le site n'a pas d'API. Sous Linux, le paquet
`libreoffice-script-provider-python` de la distribution est nécessaire.
