# Complément Word

Un **complément Office** (*Office Add-in*) dans `word/`, qui mesure la rédaction dans **Word pour
Windows et Mac (Microsoft 365, Mac 2019+) et Word sur le web**, avec le même volet que la popup
de l'extension : connexion, document Certimens du document, rendu sur un devoir, envoi du .docx
(lu directement dans Word, sans téléchargement).

## Les fichiers

- `sensor.js` : un complément ne reçoit pas les frappes du document. Chaque modification locale
  (changement de sélection, paragraphe modifié, WordApi 1.6) déclenche une relecture du texte ;
  la différence avec la lecture précédente dit ce qui a été inséré ou effacé. Les modifications
  des co-auteurs sont ignorées. Mêmes metrics que l'extension, sauf `mad_ms`, `median_flight_ms`
  et `focus_losses` (voir *Écarts assumés* dans [mesures.md](mesures.md)). Une « frappe » y est
  un caractère inséré ou effacé ; le détail est en tête du fichier. Office ne signalant ni
  l'enregistrement ni la sortie du document, ses fenêtres partent sur l'inactivité, sur les
  200 frappes et à la fermeture du volet.
- `agent.js` : l'équivalent de `background.js` (file hors-ligne dans `localStorage`, renvoyée
  chaque minute). Chaque document garde son identifiant dans ses réglages, il suit donc le .docx.
- `taskpane.html` / `taskpane.js` : le volet. Il reste chargé volet fermé (runtime partagé) ;
  une fois le fichier créé, Word rouvre le complément avec le document.
- `index.html` : la page d'accueil du site. Word ne la charge jamais (il va droit à
  `taskpane.html`), mais GitHub Pages ne sert aucun listing de dossier : sans elle, l'adresse du
  site répond 404 alors que tous les fichiers sont bien là. Le build y injecte la version.

Le build reprend de `browser/` la feuille de style `ui.css`, le code partagé des deux volets
`ui.js`, le dictionnaire `i18n.js` ([langues.md](langues.md)), les polices et les icônes : le
volet Word et la popup sont le même écran, ils n'ont pas deux jeux de textes.

## Hébergement

Le complément est une page web servie par **GitHub Pages**
(`https://certimens.github.io/plugins/word/`, variable `WORD_BASE_URL` du build). Le moteur
autorise cette origine en CORS sur `/api` — voir [moteur.md](moteur.md).

### Ce qui est installé, et ce qui est servi

C'est la particularité de cet agent, et elle va dans les deux sens :

- **Le manifest est installé chez l'étudiant.** Il fige cinq adresses — `taskpane.html` et les
  quatre icônes — et plus rien de ce qu'on y change n'atteint quelqu'un de déjà installé. Un
  nouveau manifest veut dire revue AppSource, ou déploiement par l'admin du tenant.
- **Le code, lui, est relu à chaque ouverture du volet.** Un déploiement part donc chez tout le
  monde immédiatement, sans revue — c'est l'intérêt du montage, et c'est aussi le risque : un
  mauvais déploiement casse tous les étudiants d'un coup, et le seul recours est d'en refaire
  un.

**Ne jamais déplacer `taskpane.html` ni `icons/`** : ce sont les seules adresses que le
manifest connaît, et un étudiant installé ne les reverra jamais changer.

### Le volet se rattrape tout seul

Toutes les adresses sont stables, et le cache est traité **à l'exécution** plutôt que dans les
URL. Le site publie un `version.txt`, et un script **inline** en tête du volet le compare à la
version gravée dans la page à la construction.

Le problème qu'il règle : le volet charge six fichiers, chacun avec sa propre durée de vie de
dix minutes sur Pages — et Word garde un cache à lui, plus tenace encore. Après un déploiement,
ils peuvent être repris à des moments différents, et un `taskpane.js` neuf tourne alors sur
l'`ui.js` précédent. Le symptôme typique : une fonction qui n'existe pas, et un volet
inutilisable jusqu'à ce que l'autre cache expire.

Deux déclencheurs, une seule action :

| Déclencheur | Ce qu'il attrape |
| --- | --- |
| `version.txt` diffère de la version de la page | la page elle-même est périmée |
| une erreur est levée pendant le chargement | les fichiers sont dépareillés |

L'action reprend les sept fichiers par-dessus les caches (`fetch(…, { cache: 'reload' })`, qui
réécrit la copie fraîche dans le cache HTTP) puis recharge.

**Le garde-fou compte plus que la fonction.** Une boucle de rechargement toucherait tous les
étudiants d'un coup et serait bien pire que le bug qu'elle poursuit : le rattrapage ne s'exécute
donc **qu'une fois par session** (`sessionStorage`), ne réessaie jamais, et ne fait rien du tout
si `sessionStorage` est indisponible. L'erreur n'est écoutée que pendant les quinze premières
secondes — passé le démarrage, on ne touche plus à rien.

Il contrôle au chargement et **ne scrute jamais** : le volet peut rester ouvert des heures, et
recharger pendant que l'étudiant écrit coûterait la fenêtre de mesure en cours.

Le script est inline à dessein : c'est le seul code qui arrive avec la page, donc le seul qui
tourne encore quand les fichiers chargés en dessous sont cassés. GitHub Pages ne permet pas à un
dépôt de régler `Cache-Control` — tout est servi en `max-age=600` — et ce rattrapage est ce qui
remplace l'en-tête qu'on ne peut pas poser.

> Sur Word pour le web, ne pas l'utiliser en même temps que l'extension navigateur : la
> rédaction serait comptée deux fois (le volet le rappelle).

## Tester en local

```bash
make -C word build && make -C word serve   # HTTPS sur localhost:3000, certificat de dev au 1er lancement
```

Puis charger `word/dist/word-localhost.xml` :

- Word sur le web : *Accueil › Compléments › Plus de compléments › Mes compléments › Charger mon
  complément* ;
- Windows / Mac : `npx office-addin-debugging start word/dist/word-localhost.xml desktop`.

Le bouton **Certimens** apparaît dans l'onglet *Accueil*. Pour un moteur local, ouvrir les
**paramètres avancés** du formulaire de connexion et y saisir `http://localhost:8080`.

## Publier le site sans faire de release

Le complément est une page web : il suffit de republier GitHub Pages. Le workflow
`.github/workflows/pages.yml` le fait à la demande, depuis n'importe quelle branche :

```bash
gh workflow run pages.yml --ref ma-branche   # ou Actions › Word add-in (GitHub Pages) › Run workflow
```

Il construit la branche, valide le manifest et déploie `word/dist/word/` sur
`https://certimens.github.io/plugins/word/` — les mêmes adresses que la release, donc **rien à
recharger côté Word** : fermer et rouvrir le volet suffit. Deux réserves :

- le workflow n'apparaît dans *Actions* (et n'est lançable) qu'une fois `pages.yml` présent sur
  la branche par défaut ; ensuite `--ref` choisit la branche à publier. Si GitHub répond *branch
  is not allowed to deploy to github-pages*, c'est la règle de l'environnement : *Settings ›
  Environments › github-pages › Deployment branches* limite le déploiement à la branche par
  défaut, à élargir (ou publier depuis `main`) ;
- c'est le site de **production** qui est remplacé : les étudiants déjà équipés reçoivent ce
  build. La prochaine release le réécrasera avec celui du tag. Pour un essai qui n'engage
  personne, `make -C word serve` et `word/dist/word-localhost.xml` restent la bonne piste.

## Vérifier ce qui est en ligne

L'adresse du site sert `index.html`, et chaque fichier se teste directement, sans Word :

```bash
for f in manifest.xml taskpane.html taskpane.js agent.js sensor.js ui.css ui.js i18n.js; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://certimens.github.io/plugins/word/$f"
done
curl -s https://certimens.github.io/plugins/word/src/manifest.xml | grep -E '<Version>|SourceLocation'
```

Huit `200` et la version attendue dans le manifest : le site est bon. Un `404` **sur tous** les
fichiers veut dire que Pages n'est pas activé (*Settings › Pages › Source : GitHub Actions*) ou
qu'aucun déploiement n'a eu lieu ; un `404` sur un seul fichier vient du build.

Si le volet montre encore l'ancien code, **rouvrir le volet suffit en principe** : au
chargement, il compare sa version à `version.txt` et se rattrape tout seul (voir
[Le volet se rattrape tout seul](#le-volet-se-rattrape-tout-seul)). Il ne le fait qu'une fois
par session, donc si l'ancien code persiste après réouverture, c'est que le rattrapage a déjà
joué sans succès : vider alors le cache de Word à la main (*Insérer › Compléments › Mes
compléments* pour recharger, ou `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS).
