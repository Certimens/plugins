# Certimens — measurement agents.
#
# Four standalone projects under one roof: each declares its tooling and carries its linters,
# its tests, its build and its publication. This Makefile walks through them, and checks in
# addition what none of them can see: what binds them together (`check`). The root has neither
# tooling nor dependencies of its own, and the CI calls nothing but these targets.
#
#   make install        installs each project's tooling (once)
#   make update         raises each project's pinned versions (then run `make` again)
#   make                lint, test, then the coherence of the four
#   make lint           each agent's linters
#   make test           each agent's tests
#   make build          each agent builds its package into <agent>/dist/
#   make build RELEASE=v1.4.2    same, version imposed by the tag (release)
#   make check          what binds the four: constants, metrics, names, engine, shared links
#   make site           the documentation site published at certimens.github.io/plugins/
#   make test-host      each agent in its real host, in a container (outside `make`, not outside CI)
#   make test-host-clean  throws away the images and the downloaded hosts
#   make clean          erases the dist/ folders and the tooling each agent installed
#
# The same targets exist agent by agent: make -C browser lint, make -C word build…
# Each agent's Makefile describes at the top what else it can do — publishing included.
#
# `test-host` is the only walk-through that is not part of `make`: it starts three of the four
# agents in their real host (a real Chromium, a real VS Code, a real LibreOffice), each in a
# throwaway container. It needs Docker, it downloads and it takes minutes, where `make` must
# stay instant and offline — hence its place beside it rather than inside. The CI, for its part,
# runs it agent by agent, each behind its own unit tests: the repository is public and its
# runner minutes are not counted, whereas "remembering before every tag" is exactly what gets
# lost.
#
# In the three JavaScript agents the commands are **declared in package.json** and their
# Makefile only calls them: `npm run` inside an agent's folder lists everything it can do, and
# `npm run lint`, `npm test`, `npm run build` work without make. The Makefile gives all four —
# including the Python one, which has no npm — the same targets.

# `check` is the only target in this file that is not a plain walk-through, and it is so for a
# reason: what it verifies — one measurement rule, implemented four times — belongs to no agent,
# and no agent can see the three others. The script is standard-library Python: the root still
# has neither tooling to install nor dependencies.
AGENTS := browser word libreoffice vscode

# The three agents whose host can start in a container. The Word add-in is not among them, and
# will not be: Office.js only runs inside Word, of which there is no headless version. Checking
# it is entirely manual (word/TESTING.md).
HOST_AGENTS := browser libreoffice vscode

# Picked up by the sub-makes: the tag gives the version, never a manifest.
export RELEASE

.PHONY: all install update lint test test-host test-host-clean check site build clean

all: lint test check

install:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent install || exit 1; done

# Each agent raises its own versions, with its own tool — npm for the three in JavaScript, pip
# for the one in Python. Versions are **exact** everywhere: they say what has been verified, not
# what will be installed, and raising them is therefore a deliberate command.
#
# No runtime dependency is involved: the four agents have none. What moves here is the tooling,
# and `make` is what says whether the raise passes.
update:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent update || exit 1; done
	@echo
	@echo "Versions raised. Run 'make': an unverified version is just that."

lint:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent lint || exit 1; done

test:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent test || exit 1; done

# Deliberately outside `all`: Docker, downloads, minutes. A failing agent stops the walk, like
# the other targets — the first host that refuses the agent is the one to look at.
test-host:
	@for agent in $(HOST_AGENTS); do $(MAKE) -C $$agent test-host || exit 1; done
	@echo "The Word add-in has no automatable host: see word/TESTING.md."

test-host-clean:
	@for agent in $(HOST_AGENTS); do $(MAKE) -C $$agent test-host-clean || exit 1; done

check:
	@python3 scripts/check-coherence.py

# The installation documentation, which belongs to no agent either: it describes the four, in
# two languages, for whoever installs them rather than whoever writes them. Standard-library
# Python, like everything else at this root — there is no tooling here to install.
#
# SITE_OUT is what the Pages workflow overrides to build straight into the folder it deploys.
SITE_OUT ?= dist/site

site:
	@python3 scripts/build-site.py --out $(SITE_OUT)

build:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent build || exit 1; done

clean:
	@for agent in $(AGENTS); do $(MAKE) -C $$agent clean || exit 1; done
