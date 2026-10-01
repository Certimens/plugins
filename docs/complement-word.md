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

Le build reprend de `extension/` la feuille de style `ui.css`, le code partagé des deux volets
`ui.js`, le dictionnaire `i18n.js` ([langues.md](langues.md)), les polices et les icônes : le
volet Word et la popup sont le même écran, ils n'ont pas deux jeux de textes.

## Hébergement

Le complément est une page web servie par **GitHub Pages**
(`https://certimens.github.io/plugins/word/`, variable `WORD_BASE_URL` du build). Le moteur
autorise cette origine en CORS sur `/api` — voir [moteur.md](moteur.md).

> Sur Word pour le web, ne pas l'utiliser en même temps que l'extension navigateur : la
> rédaction serait comptée deux fois (le volet le rappelle).

## Tester en local

```bash
npm run build && npm run word:serve   # HTTPS sur localhost:3000, certificat de dev au 1er lancement
```

Puis charger `dist/word-localhost.xml` :

- Word sur le web : *Accueil › Compléments › Plus de compléments › Mes compléments › Charger mon
  complément* ;
- Windows / Mac : `npx office-addin-debugging start dist/word-localhost.xml desktop`.

Le bouton **Certimens** apparaît dans l'onglet *Accueil*. Pour un moteur local, saisir
`http://localhost:8080` comme adresse du moteur.

## Publier le site sans faire de release

Le complément est une page web : il suffit de republier GitHub Pages. Le workflow
`.github/workflows/pages.yml` le fait à la demande, depuis n'importe quelle branche :

```bash
gh workflow run pages.yml --ref ma-branche   # ou Actions › Word add-in (GitHub Pages) › Run workflow
```

Il construit la branche, valide le manifest et déploie `dist/word/` sur
`https://certimens.github.io/plugins/word/` — les mêmes adresses que la release, donc **rien à
recharger côté Word** : fermer et rouvrir le volet suffit. Deux réserves :

- le workflow n'apparaît dans *Actions* (et n'est lançable) qu'une fois `pages.yml` présent sur
  la branche par défaut ; ensuite `--ref` choisit la branche à publier. Si GitHub répond *branch
  is not allowed to deploy to github-pages*, c'est la règle de l'environnement : *Settings ›
  Environments › github-pages › Deployment branches* limite le déploiement à la branche par
  défaut, à élargir (ou publier depuis `main`) ;
- c'est le site de **production** qui est remplacé : les étudiants déjà équipés reçoivent ce
  build. La prochaine release le réécrasera avec celui du tag. Pour un essai qui n'engage
  personne, `npm run word:serve` et `dist/word-localhost.xml` restent la bonne piste.

## Vérifier ce qui est en ligne

L'adresse du site sert `index.html`, et chaque fichier se teste directement, sans Word :

```bash
for f in manifest.xml taskpane.html taskpane.js agent.js sensor.js ui.css ui.js i18n.js; do
  curl -s -o /dev/null -w "%{http_code} $f\n" "https://certimens.github.io/plugins/word/$f"
done
curl -s https://certimens.github.io/plugins/word/manifest.xml | grep -E '<Version>|SourceLocation'
```

Huit `200` et la version attendue dans le manifest : le site est bon. Un `404` **sur tous** les
fichiers veut dire que Pages n'est pas activé (*Settings › Pages › Source : GitHub Actions*) ou
qu'aucun déploiement n'a eu lieu ; un `404` sur un seul fichier vient du build.

Si le volet montre encore l'ancien code, c'est le cache : Pages sert les fichiers avec une durée
de vie de quelques minutes, et Word garde son propre cache (*Insérer › Compléments › Mes
compléments* pour recharger, ou vider `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef` sous Windows,
`~/Library/Containers/com.microsoft.Word/Data/Library/Caches` sous macOS).
