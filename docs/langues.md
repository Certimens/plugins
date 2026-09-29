# Langues

Les agents parlent **français et anglais**. Le français est la langue par défaut : le produit
est vendu à l'enseignement supérieur français, et une locale inconnue y atterrit plutôt que dans
une langue que l'établissement n'utilise pas.

## La règle

Celle du moteur : **une étiquette qui commence par `en` donne l'anglais, tout le reste donne le
français.** Elle est réimplémentée dans chaque agent plutôt que demandée au moteur — un agent
doit choisir sa langue avant d'avoir jamais joint le moteur.

La langue vient, dans cet ordre :

1. **le compte Certimens**, dont la langue arrive avec la réponse de connexion (`me.language`)
   et est conservée dans la configuration de l'agent ;
2. **la langue de l'hôte** — le navigateur, Word, LibreOffice, l'éditeur ;
3. **le français**.

Le compte l'emporte parce que c'est la langue que l'étudiant a choisie dans son espace, et celle
de ses e-mails.

## Où vivent les textes

| Agent | Textes de l'interface | Fiche et manifest |
| --- | --- | --- |
| Navigateur | `extension/i18n.js` | `extension/_locales/{fr,en}/messages.json` (`__MSG_…__` dans le manifest) |
| Word | `extension/i18n.js`, partagé et copié par le build | `<Override Locale="en-us">` dans `word/manifest.xml` |
| LibreOffice | `libreoffice/pythonpath/certimens_agent/i18n.py` | `description.xml` et `description/description-{fr,en}.txt` |
| VS Code | `vscode/i18n.js` | `vscode/package.nls.json` (français, le repli) et `package.nls.en.json` |

Aucune page ne porte de texte en dur : `data-i18n="clé"` côté extension et Word, injection à la
construction côté VS Code.

## Le manifest est lu avant notre code

C'est l'hôte qui le traduit, d'après sa **propre** langue d'interface. Le nom dans la barre
d'outils peut donc être anglais pendant que le volet est français, si le compte dit l'anglais et
le navigateur le français. Rien d'autre n'est possible pour un texte que l'hôte lit avant nous.

## Vérifier

Les suites vérifient la parité des clés, les variables (`{title}`, `{count}`) et le fait qu'une
clé commune à deux agents porte bien le **même** message : `tests/i18n.test.mjs` et
`libreoffice/tests/test_i18n.py`.

## Ajouter une langue

Cela commence **côté moteur** : il n'en connaît que deux, et l'étudiant choisirait sinon dans
son espace une langue que le moteur refuse d'enregistrer. Les quatre dictionnaires, les fiches
des boutiques et les manifests suivent.
