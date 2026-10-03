# Extension LibreOffice Writer en Python/UNO, paquet .oxt.
#
#   make install  crée .venv et y installe ruff
#   make lint     ruff
#   make test     les tests Python, sans LibreOffice
#   make coverage ce que ces tests couvrent (rapport, pas une barrière de la CI)
#   make build    dist/libreoffice.oxt
#   make clean    efface dist/, .venv/ et le cache de ruff
#
# Pas de cible publish : l'envoi sur extensions.libreoffice.org se fait à la main, le site n'a
# pas d'API (docs/publication.md).
#
# Cet agent n'a ni Node ni npm : il est en Python, et son build aussi (build.py, bibliothèque
# standard seule). Les trois autres agents déclarent leurs commandes dans un package.json ;
# ici, c'est ce Makefile.
#
# L'extension livrée n'embarque que la bibliothèque standard : .venv, ruff.toml et ce Makefile
# sont des outils de développement, et build.py les laisse hors du paquet.
#
# `python3 -m venv` demande le module ensurepip — paquet `python3-venv` sur Debian et Ubuntu.

VENV := .venv
PYTHON := python3

.PHONY: install lint test coverage build clean

# Le témoin de l'installation, comme node_modules l'est chez les trois autres : refaite
# seulement quand requirements-dev.txt bouge.
$(VENV)/.installed: requirements-dev.txt
	@$(PYTHON) -c 'import ensurepip' 2>/dev/null || { \
		echo "ensurepip absent : installer le paquet python3-venv (Debian, Ubuntu)." >&2; \
		exit 1; }
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --disable-pip-version-check -r requirements-dev.txt
	@touch $(VENV)/.installed

install: $(VENV)/.installed

lint: $(VENV)/.installed
	$(VENV)/bin/ruff check .

# Les tests ne demandent que la bibliothèque standard : pas de venv, comme l'extension livrée.
test:
	$(PYTHON) -m unittest discover -s tests

coverage: $(VENV)/.installed
	$(VENV)/bin/python -m coverage run -m unittest discover -s tests
	$(VENV)/bin/python -m coverage report

build:
	$(PYTHON) build.py $(if $(RELEASE),--release $(RELEASE))

clean:
	rm -rf dist $(VENV) .ruff_cache .coverage
