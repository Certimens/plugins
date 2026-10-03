# CI et publication

## Les workflows

- **CI** (`.github/workflows/ci.yml`) : **un job par projet** — chacun installe son outillage
  et appelle son propre `Makefile`, comme on le ferait en local, plus un job pour la
  documentation. Un agent qui casse ne masque pas les autres. Les zips du
  navigateur sont joints au run (artefact `extension`), comme le `.oxt` LibreOffice et le
  `.vsix` VS Code (artefacts `certimens-libreoffice` et `certimens-vscode`). Un job macOS
  convertit le paquet Safari, compile l'app sans signature et joint le projet Xcode (artefact
  `safari-xcode`).
- **Dépendances** (`.github/dependabot.yml`) : Dependabot suit chaque lundi les paquets npm de
  l'outillage et les actions des workflows (mises à jour mineures et correctives groupées,
  majeures séparées). Chaque projet ayant son `package-lock.json`, il y a un `package-ecosystem`
  par dossier. Côté LibreOffice, le suivi porte sur `requirements-dev.txt` (ruff) : le code
  livré, lui, n'a que la bibliothèque standard.
- **Pages** (`.github/workflows/pages.yml`) : publie le site du complément Word à la demande,
  sans release ni tag (voir [complement-word.md](complement-word.md)). Même cible que la
  release, un seul déploiement à la fois (groupe de concurrence `github-pages`).
- **Release** (`.github/workflows/release.yml`) : un tag `vX.Y.Z` relance la CI, qui construit
  **une seule fois** les paquets, puis publie. La publication elle-même est une cible du
  `Makefile` de l'agent concerné — `make -C browser publish-chrome`,
  `make -C vscode publish` — et le workflow ne fait que fournir les identifiants et sauter les
  boutiques non configurées. La même commande marche donc à la main.

## Publier une version

C'est **le tag qui donne la version** à tous les paquets : rien n'est à modifier à la main avant
de le poser.

```bash
git tag v1.5.0
git push origin v1.5.0
```

Ensuite, le workflow de release :

1. crée une release GitHub `vX.Y.Z` avec les paquets et leurs empreintes :
   `certimens-agent-X.Y.Z-{chrome,firefox,safari,safari-xcode}.zip`, `SHA256SUMS.txt` ;
2. publie le complément Word sur GitHub Pages (le manifest Word est joint à la release) : les
   étudiants ont la nouvelle version à la prochaine ouverture de Word, sans repasser par
   AppSource tant que le manifest ne change pas ;
3. joint l'extension LibreOffice (`certimens-agent-X.Y.Z-libreoffice.oxt`), à déposer à la main
   sur extensions.libreoffice.org, qui n'a pas d'API
   ([`libreoffice/store/`](../libreoffice/store/)) ;
4. joint l'extension VS Code (`certimens-agent-X.Y.Z-vscode.vsix`) et la publie sur le Visual
   Studio Marketplace si `VSCE_PAT` est configuré. Le Marketplace n'accepte que des versions
   `X.Y.Z` : un build de branche, versionné `X.Y.Z-commit`, n'est donc jamais publiable — c'est
   voulu ;
5. publie ces mêmes fichiers sur le Chrome Web Store, addons.mozilla.org et, s'ils sont
   configurés, Edge Add-ons et Opera Add-ons (`publish-browser-extension`), un job par store. Un
   store en échec ne bloque ni les autres ni la release GitHub : relancer son job seul (*Re-run
   failed jobs*).

**Safari** reste manuel, depuis Xcode, à partir du `safari-xcode.zip` de la release pour garder
la même version que les autres stores.

Les boutiques relisent chaque version avant de la mettre en ligne : de quelques heures à
quelques jours.

## Mise en place (une seule fois par boutique)

La **première** publication se fait à la main dans chaque store ; la CI ne sait que mettre à
jour une extension existante. Chaque fiche demande une adresse d'assistance : partout
`contact@certimens.fr`, avec `https://certimens.fr` comme site. Les paquets portent le nom et la
description dans les deux langues, mais **aucune boutique ne traduit la fiche à partir du
paquet** : chacune a un onglet par langue, à remplir à la main. **Les textes de chaque fiche
vivent chez l'agent concerné**, un dossier par boutique :
[`browser/store/`](../browser/store/), [`word/store/`](../word/store/),
[`libreoffice/store/`](../libreoffice/store/), [`vscode/store/`](../vscode/store/). Ce qui suit
n'est que la mise en place des comptes et des identifiants.

### Chrome Web Store

1. Créer un compte développeur (frais uniques de 5 $) sur le
   [tableau de bord](https://chrome.google.com/webstore/devconsole).
2. Téléverser `browser/dist/chrome.zip`, remplir la fiche et soumettre — tout le contenu
   (description, capture, justification de chaque permission, données collectées) est dans
   [`browser/store/chrome/`](../browser/store/chrome/).
3. Relever l'**ID de l'extension** (32 lettres) et l'**ID d'éditeur** (*Compte* dans le tableau
   de bord).
4. Dans Google Cloud : activer la *Chrome Web Store API*, créer un compte de service et une clé
   JSON, puis ajouter l'e-mail du compte de service dans le tableau de bord du Chrome Web Store
   (*Compte* › accès à l'API).

### Firefox (addons.mozilla.org)

1. Créer un compte sur le [Developer Hub](https://addons.mozilla.org/developers/).
2. Soumettre `browser/dist/firefox.zip` (*Sur ce site*). L'ID `agent@certimens.fr` vient du
   manifest : il ne peut plus changer une fois publié.
3. Générer les clés d'API : *Tools › Manage API Keys* (JWT issuer et JWT secret).

### Edge Add-ons (facultatif)

1. Créer un compte dans le [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
   (gratuit), soumettre `browser/dist/chrome.zip`.
2. Relever le **Product ID**, puis *Publish API* : activer l'API v1.1, relever le **Client ID**
   et créer une **API key**.

### Opera Add-ons (facultatif)

Sans store dédié, Opera installe aussi les extensions du Chrome Web Store (*Install Chrome
Extensions*). Pour une fiche sur [addons.opera.com](https://addons.opera.com/developer/) :
soumettre `browser/dist/chrome.zip` avec l'image promotionnelle de
[`browser/store/opera/`](../browser/store/opera/), relever l'ID du paquet. Opera n'a pas d'API : la CI utilise le cookie `sessionid` du compte développeur, à
renouveler quand il expire.

### Visual Studio Marketplace

1. Créer une organisation sur [Azure DevOps](https://dev.azure.com) avec le compte Microsoft de
   Certimens, puis un **éditeur** (*publisher*) `certimens` sur le
   [portail Marketplace](https://marketplace.visualstudio.com/manage) — l'identifiant doit être
   celui du champ `publisher` de `vscode/package.json`, il ne change plus une fois publié.
2. Créer un **jeton d'accès personnel** (Azure DevOps › *User settings › Personal access
   tokens*) pour *All accessible organizations*, portée *Marketplace › Manage*, et l'enregistrer
   dans le secret `VSCE_PAT` du dépôt.
3. Première publication à la main : `make -C vscode build && make -C vscode publish` (avec
   `VSCE_PAT` dans l'environnement). Les suivantes partent de la release.

La fiche, elle, **est le paquet** : le Marketplace lit tout dans `vscode/package.json` et
affiche `vscode/README.md` — ce qu'il faut y vérifier est dans
[`vscode/store/marketplace/`](../vscode/store/marketplace/).

**Open VSX** (facultatif, pour VSCodium, Cursor et Gitpod) : dépôt distinct de Microsoft, sans
publication automatisée ici — déposer le `.vsix` de la release à la main
([`vscode/store/open-vsx/`](../vscode/store/open-vsx/)).

### Safari (App Store)

La fiche est celle d'une **application**, pas d'une extension :
[`browser/store/safari/`](../browser/store/safari/).

1. Adhérer à l'[Apple Developer Program](https://developer.apple.com/programs/) (99 $/an).
2. Sur un Mac : `make build && make -C browser safari`, ouvrir le projet Xcode, choisir
   l'équipe dans *Signing & Capabilities* des quatre cibles (app et extension, macOS et iOS).
3. *Product › Archive* pour chaque plateforme, puis *Distribute App › App Store Connect*.
4. Dans [App Store Connect](https://appstoreconnect.apple.com), remplir la fiche
   (confidentialité comprise) et soumettre. À chaque version, recommencer à l'étape 2.

### Word (AppSource)

1. Activer GitHub Pages sur le dépôt : *Settings › Pages › Source : GitHub Actions*. Sur un
   dépôt privé, Pages demande un plan GitHub payant (Team ou Enterprise).
2. Publier une première release (le site doit être en ligne pour la validation).
3. Créer un compte dans le [Partner Center](https://partner.microsoft.com/dashboard) (programme
   *Microsoft 365 et Copilot*, gratuit), nouvelle offre *Complément Office*, envoyer
   `certimens-agent-X.Y.Z-word-manifest.xml` de la release.
4. Remplir la fiche avec [`word/store/appsource/`](../word/store/appsource/) — textes, logo et
   notes pour les testeurs — et donner un compte de test aux validateurs de Microsoft.

Une fois publié, seul un changement du manifest (nom, icônes, autorisations, adresses) repasse
par la validation ; le code, lui, est pris sur GitHub Pages à chaque ouverture.

## Secrets et variables GitHub

Dépôt › *Settings › Secrets and variables › Actions* :

| Nom | Type | Valeur |
| --- | --- | --- |
| `CHROME_EXTENSION_ID` | variable | ID de l'extension sur le Chrome Web Store |
| `CHROME_PUBLISHER_ID` | variable | ID d'éditeur du Chrome Web Store |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | secret | `client_email` de la clé JSON du compte de service |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | secret | `private_key` de la même clé |
| `FIREFOX_JWT_ISSUER` | secret | JWT issuer d'addons.mozilla.org |
| `FIREFOX_JWT_SECRET` | secret | JWT secret d'addons.mozilla.org |
| `EDGE_PRODUCT_ID` | variable | Product ID Edge Add-ons (vide : Edge ignoré) |
| `EDGE_CLIENT_ID` | variable | Client ID de la Publish API Edge |
| `EDGE_API_KEY` | secret | API key de la Publish API Edge |
| `OPERA_PACKAGE_ID` | variable | ID du paquet Opera (vide : Opera ignoré) |
| `OPERA_SESSION_ID` | secret | Cookie `sessionid` d'addons.opera.com |
| `VSCE_PAT` | secret | Jeton Azure DevOps du Visual Studio Marketplace |
