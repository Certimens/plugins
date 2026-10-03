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
- **Pages** (`.github/workflows/pages.yml`) : publie le **site** à la demande, sans release ni
  tag (voir [complement-word.md](complement-word.md)), et c'est aussi ce que la release appelle.
  Un seul déploiement à la fois (groupe de concurrence `github-pages`). Ce que le site porte, et
  pourquoi un déploiement les porte tous les deux : [plus bas](#le-site-github-pages).
- **Release** (`.github/workflows/release.yml`) : **lancé à la main**, *Actions › Release › Run
  workflow*. Il dit d'abord ce qu'il reste à publier, puis, pour l'agent choisi, relance la CI
  **pour cet agent seul**, pose et pousse son tag, crée la release et publie sur ses boutiques.
  La publication elle-même est une cible du `Makefile` de l'agent concerné — `make -C browser
  publish-chrome`, `make -C vscode publish` — et le workflow ne fait que fournir les
  identifiants et sauter les boutiques non configurées. La même commande marche donc à la main.
  Un tag `<agent>-vX.Y.Z` poussé à la main déclenche le même workflow, qui reconnaît alors le
  tag déjà posé.

## Publier une version

**Un agent, un tag, une version.** Le préfixe du tag nomme l'agent, le reste donne la version, et
aucun manifest n'est à modifier à la main avant de le poser. **Le tag se pose depuis GitHub**,
dans le run qui publie : il n'y a rien à faire sur le poste de qui publie.

L'agent dans son hôte réel est vérifié par la CI, dans un job qui suit ses tests unitaires
([developpement.md](developpement.md#dans-lhôte-pour-de-vrai--make--c-agent-test-host)) : un tag
dont la CI est verte a donc déjà démarré dans un vrai Chromium, un vrai VS Code ou un vrai
LibreOffice. Ce qui reste avant de taguer est la liste de **`<agent>/TESTING.md`**, ce qui ne se
vérifie qu'à la main : le DOM des éditeurs, les fenêtres, les parcours avec un vrai compte. Pour
le complément Word, c'est la **seule** vérification dans l'hôte qui existe — Office.js ne
s'exécute que dans Word.

Reste **la section du journal**. Sortir de « Non publié » ce qui touche cet agent, en faire une
section `## <agent> <version>` dans [`CHANGELOG.md`](../CHANGELOG.md), y écrire les deux phrases
bilingues que la boutique demande, commiter. La release **échoue tout de suite** si la section
n'existe pas, avant de construire quoi que ce soit : une version sans notes se découvrirait
sinon une demi-heure plus tard, au moment de remplir la fiche de la boutique.

### Le bouton

*Actions › Release › Run workflow*, trois champs :

| Champ | Ce qu'il fait |
| --- | --- |
| **agent** | celui qu'on publie, ou **`report only`** (le défaut) : rien n'est publié, le run n'écrit qu'un rapport |
| **version** | `X.Y.Z`, ou **vide** — et c'est la section du journal qui n'a pas encore de tag qui la donne |
| **dry_run** | **coché par défaut** : tout est vérifié, rien n'est publié. Décocher est le geste qui publie |

Le rapport est dans le résumé du run (`scripts/release-plan.py`, lisible aussi en local avec
`python3 scripts/release-plan.py`). Il dit, pour chacun des quatre : son dernier tag, les
commits qui ont touché **son paquet** depuis — liens symboliques suivis, donc un `ui.css`
modifié se voit chez les trois agents qui le partagent —, ceux qui l'ont touché sans entrer dans
le paquet (tests, fiches de boutique), et ce que le journal lui consacre déjà. C'est la réponse
à « qu'est-ce qu'il reste à publier ? », et elle ne se devine pas : un agent ne voit pas les
trois autres.

Avec un agent choisi, le run **refuse** et n'écrit rien si la version est mal formée, si son tag
existe déjà, si elle n'avance pas sur le dernier tag de cet agent, si le journal ne lui consacre
pas de section, ou si **aucun commit n'a touché le paquet** depuis le dernier tag — ce dépôt-là
ferait relire par ses boutiques un paquet qu'elles ont déjà. Si c'est voulu quand même (un
paquet refusé par une boutique, par exemple), le tag posé à la main reste accepté et déclenche
le même workflow :

```bash
python3 scripts/changelog-section.py browser 1.5.0   # relire ce que la release publiera
git tag browser-v1.5.0                               # ou word-v…, libreoffice-v…, vscode-v…
git push origin browser-v1.5.0
```

Dans les deux cas, le tag n'est posé qu'**après** une CI verte : un tag ne doit pas nommer un
paquet qui ne se construit pas, et une version grillée par un test rouge ne se repose pas. Le
tag poussé par le run ne relance pas ce workflow (GitHub ne redéclenche rien sur un push fait
avec le jeton du run) : la release continue dans le run qu'on regarde.

Les quatre agents étaient auparavant versionnés **ensemble** : un tag `vX.Y.Z` republiait les
quatre, y compris ceux dont pas une ligne n'avait bougé. Une boutique relit un paquet à chaque
dépôt — AMO et AppSource à la main, en quelques jours — et trois de ces quatre relectures
portaient sur un paquet identique au précédent. **Les versions des quatre divergent donc, et
c'est le but** : celle qu'affiche une boutique est celle du code qu'elle sert. Chaque build ne
lit que ses propres tags (`git describe --match`), et refuse bruyamment celui d'un autre agent.

Reste la contrepartie, à connaître : ce que les quatre partagent — `ui.css`, `ui.js`, `i18n.js`,
les polices, les icônes — vit dans `browser/src/` et arrive chez les autres par des liens
symboliques. **Un changement dans l'un de ces fichiers touche trois agents** et demande trois
tags. C'est précisément ce que le rapport nomme — le fichier partagé modifié, et les
agents qu'il engage — plutôt que de le laisser au réflexe de regarder le chemin du fichier avant
de choisir combien de tags poser.

Ensuite, le workflow de release :

1. crée une release GitHub `<agent>-vX.Y.Z` — intitulée du nom de l'agent, avec **pour notes la
   section que le journal lui consacre**, suivie d'un lien vers la comparaison depuis son tag
   précédent à lui — portant ses paquets et leurs empreintes dans `SHA256SUMS.txt` :
   - `browser` → `certimens-browser-X.Y.Z-{chrome,firefox,safari,safari-xcode}.zip`,
   - `word` → `certimens-word-X.Y.Z-manifest.xml`,
   - `libreoffice` → `certimens-libreoffice-X.Y.Z.oxt`,
   - `vscode` → `certimens-vscode-X.Y.Z.vsix` ;
2. `word-v…` publie le site : les étudiants ont la nouvelle version du complément à la
   prochaine ouverture de Word, sans repasser par AppSource tant que le manifest ne change pas ;
3. `libreoffice-v…` publie le site lui aussi, pour y écrire son **flux de mise à jour** — c'est
   ce qui prévient les extensions déjà installées ([extension-libreoffice.md](extension-libreoffice.md#mettre-à-jour-une-extension-déjà-installée)).
   Le `.oxt` reste à déposer à la main sur extensions.libreoffice.org, qui n'a pas d'API
   ([`libreoffice/store/`](../libreoffice/store/)), mais plus personne n'attend ce dépôt pour
   être à jour ;
4. `vscode-v…` publie sur le Visual Studio Marketplace si `VSCE_PAT` est configuré. Le
   Marketplace n'accepte que des versions `X.Y.Z` : un build de branche, versionné
   `X.Y.Z-commit`, n'est donc jamais publiable — c'est voulu ;
5. `browser-v…` publie sur le Chrome Web Store, addons.mozilla.org et, s'ils sont configurés,
   Edge Add-ons et Opera Add-ons (`publish-browser-extension`), un job par store. Un store en
   échec ne bloque ni les autres ni la release GitHub : relancer son job seul (*Re-run failed
   jobs*).

La **cohérence des quatre** (`make check`) tourne à chaque release, y compris pour les trois
agents qu'elle ne construit pas : c'est le seul contrôle qui les regarde ensemble, et le moment
de publier est le dernier où une divergence doit passer.

**Safari** reste manuel, depuis Xcode, à partir du `safari-xcode.zip` de la release de
l'extension navigateur, pour garder la version de son tag.

Le texte **« Nouveautés »** qu'aucune de ces étapes ne remplit se recopie de la release
elle-même : elle porte la section du journal, et donc les deux phrases à coller — en français et
en anglais, aucune boutique ne traduisant une fiche à partir du paquet. C'est la raison d'être de
ces notes-là : la liste des commits dit ce que le dépôt a fait, mêle les quatre agents, et ne se
colle nulle part. Elle reste à un lien de distance, pour qui la cherche.

Les boutiques relisent chaque version avant de la mettre en ligne : de quelques heures à
quelques jours.

## Le site GitHub Pages

Le dépôt publie **un** site, et trois choses y vivent :

| Adresse | À quoi ça sert | Qui l'écrit |
| --- | --- | --- |
| `/`, `/<agent>/`, `/en/`, `/en/<agent>/` | la documentation d'installation, en français et en anglais — ce que lit l'étudiant, et l'établissement qui déploie | `scripts/build-site.py` |
| `/word/` (les mêmes dossiers) | le complément Word lui-même — c'est le code que Word charge à chaque ouverture | le build de `word` |
| `/libreoffice/update.xml` | le flux que chaque `.oxt` installé interroge | `libreoffice/build.py` |

**Deux parties partagent un dossier, et c'est voulu.** La page de doc d'un agent est à l'adresse
de cet agent : `/word/` sert à la fois la page qui explique comment installer le complément et
le complément lui-même (`taskpane.html`, `manifest.xml`, les icônes…), et `/libreoffice/` sert la
page et le flux `update.xml`. Un seul nom est disputé, **`index.html`** — et la documentation le
gagne. Le complément n'en embarquait un que parce que GitHub Pages ne sert pas de listing de
dossier ; une page bilingue qui explique l'installation fait ce travail-là mieux.

C'est l'**ordre d'assemblage** qui rend ça sûr : les fichiers des agents d'abord, la
documentation par-dessus. Aucune des cinq adresses gelées dans un manifest installé
(`taskpane.html` et quatre icônes) ne porte ce nom, donc rien de ce qu'un manifest pointe n'est
jamais recouvert — et le workflow le **vérifie** après coup, fichier par fichier, avant de
déployer.

**Un déploiement remplace le site entier** : `actions/deploy-pages` ne connaît pas la mise à
jour partielle, et ce qui n'est pas dans l'artefact disparaît. Les deux parties appartenant à
deux agents aux versions distinctes, chaque déploiement — quel que soit l'agent qui le
déclenche — doit donc porter les deux. C'est tout l'objet de `pages.yml`, et la raison pour
laquelle rien d'autre dans le dépôt n'appelle `deploy-pages`.

D'où vient chaque partie dépend de qui déploie :

| Déclencheur | `/` | `/word/` | `/libreoffice/update.xml` |
| --- | --- | --- | --- |
| `workflow_dispatch` | la branche choisie | **reconstruit au dernier tag `word-v*`**, sauf `word: branch` | le dernier tag `libreoffice-v*` |
| release de `word` | le commit du tag | le paquet du run, à son tag | le dernier tag `libreoffice-v*` |
| release de `libreoffice` | le commit du tag | **reconstruit au dernier tag `word-v*`** | le tag publié |

La reconstruction est ce qui demande une explication. Le complément n'est pas un paquet, il est
**servi** : ce qui est en ligne est ce qui s'exécute, devant tous les étudiants, à la seconde où
c'est déployé. Publier la documentation — ou un flux LibreOffice — ne doit donc pas emporter au
passage le code Word de la branche. Le complément est reconstruit depuis un `git worktree` posé
sur son propre dernier tag : même source, même version, mêmes fichiers que le déploiement qui
l'avait publié. Un `git checkout -- word` ne suffirait pas — `ui.css`, `ui.js`, `i18n.js`, les
polices et les icônes sont des liens vers `browser/`, et on reconstruirait le complément du tag
autour des fichiers partagés d'aujourd'hui.

**Avant la première release, le site ne porte que la documentation.** Les deux autres parties
descendent de tags, et il n'y en a aucun : le complément est « reconstruit au dernier tag
`word-v*` », qui n'existe pas, et le flux refuse d'annoncer une version sans release derrière
elle — son `.oxt` serait un 404. Tant que rien n'est tagué, `…/plugins/word/taskpane.html` et
`…/plugins/libreoffice/update.xml` répondent donc 404, et c'est le comportement voulu, pas une
panne. Pour mettre le complément en ligne sans attendre une release, c'est `word=branch`
ci-dessous ; pour le flux, il faut la première release `libreoffice-v…`, qui écrit le flux et le
déploie dans le même run. Le site vérifie et le dit : un run qui déploie sans complément écrit
un avertissement nommant le 404 à venir.

Publier un correctif Word sans release reste possible, mais se demande :

```bash
gh workflow run pages.yml --ref ma-branche                  # doc et flux ; le complément reste celui qui est publié
gh workflow run pages.yml --ref ma-branche -f word=branch   # …et le complément de la branche avec
```

## La documentation d'installation

`scripts/build-site.py` écrit les dix pages du site (une d'accueil et une par agent, en français
et en anglais) à partir de `scripts/site_content.py`. `make site` les construit dans `dist/site`,
et la CI le lance à chaque run : c'est là que trois choses sont vérifiées, et nulle part ailleurs.

- **Les deux langues portent les mêmes pages, construites pareil**, jusqu'au nombre d'étapes
  d'une liste. Une page écrite dans une seule langue fait échouer le build ([langues.md](langues.md)).
- **Le balisage des textes est équilibré.** La prose porte du `<strong>`, du `<code>`, des liens,
  écrits à la main ; une balise laissée ouverte avale le reste de la page, et la racine n'a pas
  de linter HTML.
- **Toute classe qu'habille `scripts/site.css` est portée par une page.** La feuille ne tient que
  ce que le site vitrine ne couvre pas ; une règle survit facilement au balisage qu'elle habillait,
  et personne n'ose plus y toucher faute de savoir si elle sert encore. Ce contrôle voit des
  **noms, pas des formes** : un sélecteur dont toutes les classes existent mais dont l'imbrication
  ne se produit jamais passe au travers. Les débusquer demande de confronter chaque sélecteur aux
  pages construites avec un vrai moteur de sélecteurs, que ce script n'a pas à porter
  (bibliothèque standard, comme tous les builds ici) : c'est un audit à mener à la main quand la
  feuille a grossi, et `cheerio` est déjà dans `browser/node_modules`.

Les illustrations ne sont **pas des captures** : ce sont les fenêtres des agents, dans leur
propre balisage, avec la feuille de style que les agents livrent (`browser/src/ui.css`) et les
phrases lues dans leur dictionnaire (`browser/src/i18n.js`). Une clé renommée fait donc échouer
ce build au lieu de laisser un mensonge sur une page. Les écrans **des boutiques** sont décrits
en mots et jamais dessinés : une imitation convaincante de l'interface d'un tiers est un mensonge
quelle que soit sa légende, et ces interfaces changent sans prévenir.

### Le style vient du site vitrine, en direct

**Le menu est la seule chose recopiée.** Un menu est du balisage, pas une feuille de style : il
n'y a pas moyen de le partager entre deux dépôts sans aller chercher du HTML à la construction.
Il vit donc dans `scripts/site_content.py`, et **il dérivera** — une entrée ajoutée au menu du
site vitrine est à ajouter là aussi, et rien ne le dira.

Le site vitrine est servi à `/` et cette documentation à `/plugins/`, **sur le même hôte**
([`Certimens/certimens.github.io`][site-depot]) : sa feuille de style est donc à un lien absolu,
et chaque page la charge telle qu'elle est servie.

```html
<link rel="stylesheet" href="assets/ui.css">        <!-- les agents -->
<link rel="stylesheet" href="/assets/css/style.css"> <!-- le site vitrine, en direct -->
<link rel="stylesheet" href="assets/site.css">       <!-- nous, le dernier mot -->
```

**L'ordre est la conception.** La feuille du site vitrine passe après celle des agents, donc
elle gagne partout — ce qu'un document veut. Le mot-symbole, le logo du pied de page, l'en-tête,
le pied de page, les cartes et les boutons sont les siens, classe pour classe. Et comme c'est le
fichier vivant, **le jour où le site vitrine change, ces pages changent avec lui**. Rien n'est
recopié, rien n'est redistribué : c'est ce qui évite de faire entrer une feuille « tous droits
réservés » dans un dépôt AGPL, et ce qui rendait le sous-module inacceptable.

Ce que `scripts/site.css` ajoute, et c'est tout :

- ce qu'un site vitrine n'a pas — les étapes numérotées, la grille des agents, le chemin manuel
  replié, le code en ligne ;
- rien pour la navigation : c'est **celle du site vitrine**, items pour items, avec une entrée
  « Plugins » en plus, son bouton burger et son script (`/assets/js/site.js`, même hôte) qui
  l'ouvre sous 980 px. C'est le seul script de la page, et il n'ajoute rien à l'origine : il
  tourne déjà sur chaque page que le site vitrine y sert ;
- la **réassertion des fenêtres**, à l'intérieur de `figure.window .frame` uniquement.

La fuite joue aussi **dans l'autre sens**, et c'est moins évident : `ui.css` apporte des
**graisses** que le site vitrine n'a pas (400 et 600, contre ses 500, 700 et 800), les deux
feuilles nomment la même famille, et le navigateur fusionne toutes les fontes. Un
`font-weight: 600` de leur feuille tombe donc ici sur une fonte qui n'existe pas sur leur propre
site — c'est ce qui rendait leur menu plus clair chez nous que chez eux, et `site.css` aligne
sur ce que le site vitrine **affiche** plutôt que sur ce qu'il écrit.

Même famille, troisième forme : les **variables**. Les deux feuilles posent leurs jetons sur
`:root`, et trois noms sont communs — `--text` et `--radius`, où les deux valeurs sont les mêmes,
et `--bg`, où elles ne le sont pas (`#f8fafc` pour `ui.css`, qui décrit le fond d'un panneau,
`#fff` pour le site vitrine). La seconde feuille gagne, **donc jusque dans les illustrations** :
une variable posée sur la racine traverse tout. `site.css` la remet sur `figure.window .frame`,
là où le cadre en a besoin. Le reste des deux palettes ne se croise pas : `--accent` et `--gold`,
`--divider` et `--line`, `--text-secondary` et `--muted` portent les mêmes couleurs sous des noms
différents, ce qui est la raison pour laquelle il n'y a qu'un seul conflit à traiter.

Et quatrième forme, la plus facile à écrire sans la voir : **le poids de nos propres sélecteurs
sur leurs composants**. `.agents a.card span` pesait plus lourd que `.card__icon` et que
`.card:hover .card__icon` — il habillait donc aussi le pictogramme, qui sortait gris sur le
disque ardoise là où le site vitrine le veut blanc, et restait gris sur le disque or là où il
passe à l'encre : les deux états paraissaient échangés. La règle porte maintenant un
`:not(.card__icon)`. C'est la règle générale à retenir : **ce qui est à eux reste habillé par
eux**, et ce qu'on écrit ici vise notre texte, nommément.

Ce dernier point est le prix à connaître. Les deux feuilles ne sont pas d'accord : le site
vitrine habille `.card`, `.btn`, `body`, `h1`, `p`, `a` ; `ui.css` habille les mêmes noms pour un
**panneau**. Les illustrations sont le balisage réel des agents, et rendues dans la typographie
du document elles montreraient à l'étudiant une fenêtre qui n'existe pas. La liste des règles
remises en place est volontairement courte, et c'est elle qu'on relit quand le site vitrine
bouge : une règle à eux sur une classe qu'`ui.css` emploie aussi atteindra l'intérieur du cadre,
et **rien dans le build ne peut le voir** — la feuille n'est pas ici. Ça se vérifie en ouvrant
une page.

Deux conséquences de plus, du même fait :

- une page construite par `make site` **ne se relit pas hors ligne** : la feuille vit sur l'hôte.
  Pour la voir, il faut la servir à côté du site vitrine, ou la regarder une fois déployée ;
- le site est épinglé en **thème clair** (`data-theme="light"`, l'échappatoire que `ui.css`
  documente), parce que le site vitrine n'a qu'un thème.

> **Le domaine n'est pas encore basculé.** Le `CNAME` du dépôt vitrine dit `certimens.fr`, mais
> ce domaine répond aujourd'hui autre chose que GitHub Pages : tout est servi sur
> `certimens.github.io`. Les liens absolus ci-dessus suivront le basculement tout seuls, puisque
> c'est l'origine qui compte. Deux choses ne suivront pas, et sont à traiter **avant** :
> les cinq URL gelées dans le manifest Word, et l'origine CORS autorisée côté moteur
> ([complement-word.md](complement-word.md)).

[site-depot]: https://github.com/Certimens/certimens.github.io

Les adresses des fiches de boutique sont dans **une seule table**, en tête de
`scripts/site_content.py`. Tant qu'une fiche n'existe pas, la valeur est vide et la page nomme la
boutique sans lier vers rien : la remplir le jour de la mise en ligne est un changement d'une
ligne.

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

### Ce que ces jobs installent, et pourquoi pas le reste

Les jobs du tableau ci-dessus sont les seuls du dépôt à porter des identifiants — ceux des
boutiques, celui du Marketplace, et le déploiement Pages, qui sert le volet Word à tous les
étudiants. Ils installent par **`make -C <agent> install-publish`**, jamais `make install` :
c'est le même verrou, mais `npm ci --ignore-scripts`.

La raison est que `npm ci` exécute le script d'installation de chaque paquet de l'arbre — 477
pour l'agent navigateur, tout l'outillage de lint et de test compris — dans le runner qui tient
la clé du compte de service Chrome et le secret JWT d'AMO. Aucun n'en déclare aujourd'hui, à
l'exception de `@vscode/vsce-sign`, dont le script télécharge un binaire servant à **vérifier**
des signatures : publier un `.vsix` déjà construit ne le fait jamais, donc le sauter ne coûte
rien ici.

« Aucun aujourd'hui » n'est pas une garantie, et Dependabot ouvre un PR groupé chaque lundi. Ce
qui en fait une règle plutôt qu'un hasard est le lint de dépendances (`npm run lint:deps`,
[developpement.md](developpement.md)) : il compare le verrou à la liste des paquets autorisés à
exécuter du code en s'installant, et **échoue sur tout le reste**. Une dépendance nouvelle qui
en déclare un se lit donc avant d'atteindre ces jobs, et pas après.
