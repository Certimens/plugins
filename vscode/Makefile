# Extension Visual Studio Code, paquet .vsix.
#
# Les commandes sont déclarées dans package.json ; ce Makefile les appelle, et c'est tout —
# `npm run` seul liste ce que l'agent sait faire. Ce package.json est aussi le manifest de
# l'extension : il n'est jamais réécrit, la version est passée à vsce en ligne de commande.
#
# L'empaquetage, c'est vsce : build.mjs ne fait que résoudre la version. Ce qui reste hors du
# .vsix est listé dans .vscodeignore.
#
#   make install  npm ci
#   make lint     ESLint (modules CommonJS, hôte d'extension)
#   make test     capteur, panneau et dictionnaire
#   make build    dist/certimens-vscode.vsix
#   make dev      ouvre une fenêtre VS Code sur ce dossier (pas besoin de construire)
#   make clean    efface dist/
#   make publish  publie sur le Visual Studio Marketplace (après make build)
#
# make publish demande VSCE_PAT dans l'environnement. Open VSX (VSCodium, Cursor, Gitpod) n'a
# pas d'API gratuite pour un éditeur vérifié : sa publication reste manuelle.
#
# media/ui.css, media/fonts, media/icon128.png et tests/helpers/ sont des liens vers browser/.

.PHONY: install lint test build dev clean publish

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules

lint: node_modules
	npm run lint

test: node_modules
	npm test

build: node_modules
	npm run build $(if $(RELEASE),-- --release $(RELEASE))

dev: node_modules
	npm run dev

clean:
	npm run clean

publish: node_modules
	npm run publish
