---
name: langues-interface
description: Français et anglais dans les quatre agents — règle de choix de la langue, dictionnaires par agent, fiches des boutiques et parité des clés. À charger avant d'ajouter ou de modifier un texte d'interface, avant d'ajouter une langue, et avant de toucher au manifest d'un agent (nom, description, libellés de commandes).
---

# Langues de l'interface

Les agents parlent **français et anglais**. Le français est la langue par défaut : le produit est
vendu à l'enseignement supérieur français, et une locale inconnue doit y atterrir plutôt que dans
une langue que l'établissement n'utilise pas.

## La règle, la même partout

C'est celle du moteur (`internal/user/domain.NormalizeLanguage`, dépôt `Certimens/engine`) :
**une étiquette qui commence par `en` donne l'anglais, tout le reste donne le français.** Elle est
réimplémentée dans chaque agent plutôt que demandée au moteur, parce qu'un agent doit choisir sa
langue avant d'avoir jamais joint le moteur.

La langue vient, dans cet ordre :

1. **le compte Certimens** — l'étudiant la choisit une fois dans son espace, elle arrive avec la
   réponse de connexion (`me.language`) et est conservée dans la configuration de l'agent ;
2. **la langue de l'hôte** — le navigateur, Word, LibreOffice, l'éditeur ;
3. **le français**.

Le compte l'emporte parce que c'est celui que l'étudiant a choisi délibérément, et parce que son
espace Certimens et ses e-mails sont déjà dans cette langue.

## Où vivent les textes

| Agent | Interface | Fiche / manifest |
| --- | --- | --- |
| Extension navigateur | `extension/i18n.js` | `extension/_locales/{fr,en}/messages.json`, `__MSG_…__` dans le manifest |
| Complément Word | `extension/i18n.js` (partagé, copié par le build) | `<Override Locale="en-us">` dans `word/manifest.xml` |
| Extension LibreOffice | `libreoffice/pythonpath/certimens_agent/i18n.py` | `description.xml` (`lang=`) et `description/description-{fr,en}.txt` |
| Extension VS Code | `vscode/i18n.js` | `vscode/package.nls.json` (fr, le repli) et `package.nls.en.json` |

Le manifest d'un agent est lu **avant** notre code : c'est l'hôte qui le traduit, d'après sa
propre langue d'interface. Le nom dans la barre d'outils peut donc être anglais pendant que le
volet est français, si le compte dit l'anglais et le navigateur le français. C'est voulu : rien
d'autre n'est possible pour un texte que l'hôte lit avant nous.

## Ce qui casse une traduction

- **Une clé oubliée dans une langue.** Les suites la cherchent : `tests/i18n.test.mjs` pour les
  dictionnaires JavaScript, `libreoffice/tests/test_i18n.py` pour le Python.
- **Une variable renommée d'un côté seulement** (`{title}`, `{count}`) : testé aussi.
- **Une clé réutilisée pour autre chose.** Les clés communes à deux agents doivent porter le
  **même message** — c'est vérifié entre l'extension et VS Code, et entre l'extension et
  LibreOffice. Un message propre à un agent prend son propre espace de noms : `bar.*` pour la
  barre d'état de VS Code, `notify.*` pour ses notifications, qui disent la même chose que le
  volet mais avec les icônes de l'éditeur et le nom du produit devant.
- **Une chaîne écrite en dur** dans une page ou un dialogue. Le HTML des agents ne porte plus de
  texte : `data-i18n="clé"` côté extension et Word, une injection à la construction côté VS Code.

## Ajouter une langue

Ajouter `es` demande quatre dictionnaires, quatre fiches, et surtout **de changer la règle** :
`normalizeLanguage` ne connaît que deux langues parce que le moteur n'en connaît que deux. Une
troisième langue commence donc côté moteur (`domain.NormalizeLanguage`, `SupportedLanguages`, les
gabarits d'e-mails et le SPA), et les agents suivent — sinon l'étudiant choisirait dans son
espace une langue que le moteur refuse d'enregistrer.
