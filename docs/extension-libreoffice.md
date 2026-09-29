# Extension LibreOffice

Une extension **Writer** en Python (UNO) dans `libreoffice/`, paquet `dist/libreoffice.oxt`
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
    origine (commandes `.uno:Paste*` interceptées), sortie de LibreOffice, enregistrement ; une
    barre d'information propose d'associer un document encore inconnu ;
  - `engine.py` : moteur et file hors-ligne (`certimens.json` du profil LibreOffice, lisible par
    l'utilisateur seul), envoyée depuis un fil dédié ; pas de CORS, les appels partent de
    LibreOffice ;
  - `agent.py` : un agent par session, attaché à chaque document Writer ;
  - `dialogs.py` : les fenêtres du menu **Certimens** (l'équivalent de la popup de l'extension),
    construites contrôle par contrôle faute de HTML : connexion, puis document Certimens du
    document, devoir et envoi du .docx. Les appels au moteur partent d'un fil dédié — sinon
    LibreOffice resterait figé le temps de la réponse.
- `tests/` : `npm run test:libreoffice`, sans LibreOffice.

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

## Publier

[extensions.libreoffice.org](https://extensions.libreoffice.org) n'a pas d'API : déposer à la
main le `.oxt` de chaque release GitHub (`certimens-agent-X.Y.Z-libreoffice.oxt`). L'identifiant
`fr.certimens.agent` (`description.xml`) ne doit plus changer.
