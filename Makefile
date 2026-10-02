# Certimens — agents de mesure.
#
# Quatre projets autonomes sous un même toit : chacun déclare son outillage, porte ses linters,
# ses tests, son build et sa publication. Ce Makefile-ci ne fait que les parcourir — la racine
# n'a ni outillage ni dépendance à elle, et la CI n'appelle rien d'autre que ces cibles.
#
#   make install        installe l'outillage de chaque projet (à faire une fois)
#   make                lint puis test
#   make lint           les linters de chaque agent
#   make test           les tests de chaque agent
#   make build          chaque agent construit son paquet dans <agent>/dist/
#   make build RELEASE=v1.4.2    idem, version imposée par le tag (release)
#   make clean          efface les dist/ et l'outillage installé par chaque agent
#
# Les mêmes cibles existent agent par agent : make -C browser lint, make -C word build…
# Chaque Makefile d'agent décrit en tête ce qu'il sait faire en plus — y compris publier.
#
# Dans les trois agents JavaScript, les commandes sont **déclarées dans package.json** et leur
# Makefile ne fait que les appeler : `npm run` dans le dossier d'un agent liste tout ce qu'il
# sait faire, et `npm run lint`, `npm test`, `npm run build` marchent sans make. Le Makefile
# donne aux quatre — dont celui en Python, qui n'a pas de npm — les mêmes cibles.

AGENTS := browser word libreoffice vscode

# Repris par les sous-makes : c'est le tag qui donne la version, jamais un manifest.
export RELEASE

.PHONY: all install lint test build clean

all: lint test

install:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent install || exit 1; done

lint:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent lint || exit 1; done

test:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent test || exit 1; done

build:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent build || exit 1; done

clean:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent clean || exit 1; done
