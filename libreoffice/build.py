#!/usr/bin/env python3
"""Builds the LibreOffice extension: dist/libreoffice.oxt, from the files of this folder
(without its tests) with the version injected into description.xml.

The standard library alone, like the extension itself: this agent has no Node, no npm and no
package.json — the three others are JavaScript, this one is not, and nothing here should
pretend otherwise.

Everything the extension installs lives in src/: the .oxt is that folder, plus the licence.
What ships is decided by where a file sits, not by a list of exceptions kept up to date by
hand — the Makefile, the ruff configuration and the virtualenv are simply not in src/.

src/icons/icon128.png is a symbolic link into the browser extension — the agents share one set
of icons. copytree dereferences it, so the .oxt carries a real file.

Versions come from git:
  --release vX.Y.Z  the tag drives the package (used by the release workflow);
  otherwise         the last tag plus the current commit, e.g. 1.4.2-a9085f3. LibreOffice
                    accepts that whole string, commit included. A checkout with no tag at all
                    builds 0.0.0, and the four agents say so the same way.

Usage: python3 build.py [--release vX.Y.Z]
"""

import argparse
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
SOURCE = HERE / 'src'
DIST = HERE / 'dist'
STAGING = DIST / 'libreoffice'

# The licence travels with the package, as the licence asks.
ALSO_SHIPPED = ('LICENSE', 'NOTICE')


def unwanted(directory, names):
    """Python's own leftovers, in `shutil.copytree(ignore=…)` form."""
    return {name for name in names if name == '__pycache__' or name.endswith('.pyc')}


def git(*args):
    """The output of a git command, or '' outside a checkout."""
    try:
        done = subprocess.run(['git', *args], cwd=HERE, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return ''  # not a git checkout, or no tag yet
    return done.stdout.strip()


def resolve_version(tag):
    if tag:
        version = tag.lstrip('v')
        if not re.fullmatch(r'\d+(\.\d+){0,3}', version):
            sys.exit(f'Tag « {tag} » : version attendue sous la forme X.Y.Z.')
        return version
    # No tag in the checkout: 0.0.0 says as much, and the label still carries the commit.
    version = git('describe', '--tags', '--abbrev=0').lstrip('v') or '0.0.0'
    commit = git('rev-parse', '--short', 'HEAD')
    return f'{version}-{commit}' if commit else version


def main():
    parser = argparse.ArgumentParser(description='Construit dist/libreoffice.oxt.')
    parser.add_argument('--release', metavar='vX.Y.Z', default='',
                        help='version imposée par le tag ; sinon, dernier tag + commit')
    label = resolve_version(parser.parse_args().release)

    shutil.rmtree(DIST, ignore_errors=True)
    # symlinks=False: the links this folder is made of are followed, so the package holds real
    # files and not paths pointing outside it.
    shutil.copytree(SOURCE, STAGING, symlinks=False, ignore=unwanted)
    for name in ALSO_SHIPPED:
        shutil.copy(HERE / name, STAGING / name)

    description = STAGING / 'description.xml'
    description.write_text(description.read_text(encoding='utf-8').replace('{{VERSION}}', label),
                           encoding='utf-8')

    oxt = DIST / 'libreoffice.oxt'
    with zipfile.ZipFile(oxt, 'w', zipfile.ZIP_DEFLATED) as package:
        # Folders get an entry of their own, as `zip -r` wrote them before: LibreOffice's own
        # package reader is the one thing here that cannot be tested from this repository.
        for path in sorted(STAGING.rglob('*')):
            package.write(path, path.relative_to(STAGING))

    (DIST / 'VERSION').write_text(label + '\n', encoding='utf-8')
    print(f'libreoffice/dist/libreoffice.oxt ({label})')


if __name__ == '__main__':
    main()
