# LibreOffice Writer extension in Python/UNO, .oxt package.
#
#   make install  creates .venv and installs ruff into it
#   make update   raises the pinned versions of requirements-dev.txt (then run `make`)
#   make lint     ruff
#   make test     the Python tests, without LibreOffice
#   make test-host   in a real LibreOffice, in a container: installation, component, document
#   make test-host-clean  throws away the container image
#   make coverage what these tests cover (report, not a CI gate)
#   make build    dist/libreoffice.oxt, and dist/update.xml when a release tag names it
#   make feed     dist/update.xml alone: the update feed GitHub Pages serves
#   make clean    erases dist/, .venv/ and ruff's cache
#
# No publish target: submitting to extensions.libreoffice.org is done by hand, the site has no
# API (docs/publication.md).
#
# This agent has neither Node nor npm: it is in Python, and so is its build (build.py, standard
# library only). The three other agents declare their commands in a package.json; here, it is
# this Makefile.
#
# The shipped extension carries nothing but the standard library: .venv, ruff.toml and this
# Makefile are development tools, and build.py leaves them out of the package.
#
# `python3 -m venv` needs the ensurepip module — package `python3-venv` on Debian and Ubuntu.

VENV := .venv
PYTHON := python3

.PHONY: install update lint test test-host test-host-clean coverage build feed clean

# The installation's witness, as node_modules is for the three others: redone only when
# requirements-dev.txt moves.
$(VENV)/.installed: requirements-dev.txt
	@$(PYTHON) -c 'import ensurepip' 2>/dev/null || { \
		echo "ensurepip missing: install the python3-venv package (Debian, Ubuntu)." >&2; \
		exit 1; }
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --disable-pip-version-check -r requirements-dev.txt
	@touch $(VENV)/.installed

install: $(VENV)/.installed

# Raises the pinned versions of requirements-dev.txt, then re-pins what was installed. This is
# tooling: the shipped extension imports nothing but the standard library, so nothing raised
# here travels in the .oxt. No third-party tool to do it — pip and sed are enough, just as this
# agent's build makes do with the standard library.
#
# **Run `make` right after**: a raised ruff version brings new rules, and the lint is what will
# say so.
update: $(VENV)/.installed
	@names=$$(sed -n 's/^\([A-Za-z0-9_.-]*\)==.*/\1/p' requirements-dev.txt); \
	 header=$$(grep '^#' requirements-dev.txt); \
	 $(VENV)/bin/pip install --quiet --disable-pip-version-check --upgrade $$names; \
	 { echo "$$header"; \
	   for name in $$names; do \
	     $(VENV)/bin/pip show $$name | awk -v n=$$name '/^Version:/ { print n "==" $$2 }'; \
	   done; } > requirements-dev.txt.new
	@mv requirements-dev.txt.new requirements-dev.txt
	@cat requirements-dev.txt

lint: $(VENV)/.installed
	$(VENV)/bin/ruff check .

# The tests need nothing but the standard library: no venv, like the shipped extension.
test:
	$(PYTHON) -m unittest discover -s tests

# What no `uno` double can tell: does the .oxt really install, does the office suite really
# register the component, does a document really open with the agent hooked onto it. In a
# throwaway container, which brings LibreOffice and its Python bridge without installing
# anything on the machine; the agent is mounted **read-only** there. Outside `make test`, which
# stays instant, offline and LibreOffice-free.
#
# The package is built beforehand, on the machine: the container cannot write.
HOST_IMAGE := certimens-libreoffice-host

test-host: build
	docker build --quiet --tag $(HOST_IMAGE) tests/host
	docker run --rm --init --volume "$(CURDIR)":/agent:ro $(HOST_IMAGE)

# The test environment, erased. Nothing was put on the machine, which was the point.
test-host-clean:
	-docker image rm $(HOST_IMAGE)

coverage: $(VENV)/.installed
	$(VENV)/bin/python -m coverage run -m unittest discover -s tests
	$(VENV)/bin/python -m coverage report

build:
	$(PYTHON) build.py $(if $(RELEASE),--release $(RELEASE))

# The update feed on its own, without building a package. This is what the Pages workflow
# calls when it is **another** agent that is being released: the site is replaced whole at
# every deployment, so the feed has to be written again even when this agent has not moved.
# It reads the last libreoffice tag and src/description.xml, and nothing else — no venv, no
# network, standard library.
feed:
	$(PYTHON) build.py --feed $(if $(RELEASE),--release $(RELEASE))

clean:
	rm -rf dist $(VENV) .ruff_cache .coverage
