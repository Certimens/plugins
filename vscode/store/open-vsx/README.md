# Open VSX — fiche de l'extension

[Open VSX](https://open-vsx.org) est le registre ouvert qu'utilisent **VSCodium, Cursor,
Gitpod, Eclipse Theia** et les dérivés de VS Code qui n'ont pas accès au Marketplace de
Microsoft. Le paquet est le même : `dist/certimens-vscode.vsix`.

La publication y est **manuelle**. L'API d'Open VSX est gratuite, mais la publication sous un
éditeur *vérifié* demande une revue de l'Eclipse Foundation, et il n'y a pas de cible `publish`
ici tant que ce n'est pas fait : déposer le `.vsix` de la release à la main.

## Ce qu'il faut avant la première publication

1. Un compte Open VSX (connexion par GitHub ou Eclipse).
2. Un **espace de noms** `certimens`, créé avec `ovsx create-namespace certimens`. Il
   correspond au champ `publisher` de `package.json`, et doit être **revendiqué** auprès de
   l'Eclipse Foundation pour que l'éditeur apparaisse comme vérifié — sinon la fiche porte un
   avertissement « éditeur non vérifié ».
3. Un jeton d'accès (*Settings › Access Tokens*).

```bash
make -C vscode build
npx ovsx publish vscode/dist/certimens-vscode.vsix -p "$OVSX_PAT"
```

## Licence

Open VSX **refuse** un paquet sans licence. Ce n'est plus un obstacle : le dépôt est sous
**Apache-2.0**, `package.json` porte l'identifiant SPDX, et le `LICENSE` de la racine est lié
dans ce dossier, donc vsce l'empaquette (`LICENSE.txt` dans le `.vsix`).

## Fiche

Comme sur le Marketplace, Open VSX lit tout dans le paquet : `package.json` pour le nom, la
description, les catégories et l'icône, [`../../README.md`](../../README.md) pour la page. Il
n'y a pas de formulaire. Voir [`../marketplace/`](../marketplace/) pour ce que ces champs
contiennent et ce qu'il faut vérifier.
