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

Versions come from git, one tag per agent:
  --release libreoffice-vX.Y.Z  the tag drives the package (used by the release workflow);
  otherwise                     the last libreoffice tag plus the current commit, e.g.
                                1.4.2-a9085f3. LibreOffice accepts that whole string, commit
                                included. A checkout with no tag for this agent builds 0.0.0,
                                and the four agents say so the same way.

Usage: python3 build.py [--release libreoffice-vX.Y.Z]
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

# Where the releases of this repository live. The update feed points at them rather than at
# extensions.libreoffice.org: the .oxt is deposited there by hand, days later, and an update
# that waits for a human is an update nobody gets.
RELEASES = 'https://github.com/certimens/plugins/releases'

# The update feed LibreOffice reads, published on GitHub Pages at the address frozen in
# src/description.xml. It answers one question — "is there a newer version, and where?" — and
# it is the only thing in this repository that tells an installed .oxt that it is out of date.
#
# `d:` and `l:` are declared here because the dependencies below are copied verbatim out of
# description.xml, prefixes included: an update must not be offered to a LibreOffice too old to
# install it, and the way to be sure of that is to not write the condition twice.
FEED = """<?xml version="1.0" encoding="UTF-8"?>
<!-- Built by libreoffice/build.py: do not edit, it is rewritten at every release. -->
<description xmlns="http://openoffice.org/extensions/update/2006"
             xmlns:d="http://openoffice.org/extensions/description/2006"
             xmlns:l="http://libreoffice.org/extensions/description/2011"
             xmlns:xlink="http://www.w3.org/1999/xlink">
  <identifier value="{identifier}"/>
  <version value="{version}"/>
{dependencies}
  <publisher>
    <name xlink:href="https://certimens.fr" lang="fr">Certimens</name>
    <name xlink:href="https://certimens.fr" lang="en">Certimens</name>
  </publisher>
  <release-notes>
    <src xlink:href="{notes}" lang="fr"/>
    <src xlink:href="{notes}" lang="en"/>
  </release-notes>
  <update-download>
    <src xlink:href="{oxt}"/>
  </update-download>
</description>
"""


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


# This agent's release tags, and no others: a tag on another agent must not version this
# package, or its store would receive a number that jumped for someone else's reason.
TAG_PREFIX = 'libreoffice-v'


def version_of_tag(tag):
    """The version a release tag carries, another agent's tag being refused.

    `v1.5.0` and `1.5.0` are accepted too: typed by hand, they can only mean this agent.
    """
    owner = re.match(r'([a-z]+)-v', tag)
    if owner and f'{owner.group(1)}-v' != TAG_PREFIX:
        sys.exit(f'Tag {tag}: that is agent {owner.group(1)}\'s tag, not this one\'s '
                 f'(expected: {TAG_PREFIX}X.Y.Z).')
    return tag[len(TAG_PREFIX):].lstrip('v') if tag.startswith(TAG_PREFIX) else tag.lstrip('v')


def resolve_version(tag):
    if tag:
        version = version_of_tag(tag)
        if not re.fullmatch(r'\d+(\.\d+){0,3}', version):
            sys.exit(f'Tag {tag}: version expected as {TAG_PREFIX}X.Y.Z.')
        return version
    # No tag for this agent in the checkout: 0.0.0 says as much, and the label still carries the
    # commit. --match keeps the three other agents' tags out of the answer.
    last = git('describe', '--tags', '--abbrev=0', '--match', f'{TAG_PREFIX}*')
    version = last[len(TAG_PREFIX):] or '0.0.0'
    commit = git('rev-parse', '--short', 'HEAD')
    return f'{version}-{commit}' if commit else version


def released_version(tag):
    """The version the feed may announce: a release, and never a build of a branch.

    `resolve_version` answers `1.4.2-a9085f3` outside a release, which is right for a package
    and wrong for the feed: that version has no release, so the .oxt it would point at does not
    exist, and every installed extension would offer the student a download ending in a 404.
    The feed therefore knows only tags — the one being released, or the last one laid.
    """
    if tag:
        return version_of_tag(tag)
    last = git('describe', '--tags', '--abbrev=0', '--match', f'{TAG_PREFIX}*')
    return last[len(TAG_PREFIX):] if last else ''


def description_parts():
    """What the feed must not say differently from the package: identifier and dependencies.

    Copied out of the shipped description.xml rather than written twice. The dependencies carry
    their `d:`/`l:` prefixes, which the feed declares as description.xml does.
    """
    text = (SOURCE / 'description.xml').read_text(encoding='utf-8')
    identifier = re.search(r'<identifier value="([^"]+)"', text)
    dependencies = re.search(r'([ \t]*<dependencies>.*?</dependencies>)', text, re.DOTALL)
    if not identifier or not dependencies:
        sys.exit('src/description.xml: identifier or dependencies not found.')
    return identifier.group(1), dependencies.group(1).rstrip()


def write_feed(version):
    """dist/update.xml, the file GitHub Pages serves to every installed extension.

    Returns where it landed: the caller reports it, and a test is free to move DIST.
    """
    identifier, dependencies = description_parts()
    DIST.mkdir(parents=True, exist_ok=True)
    path = DIST / 'update.xml'
    path.write_text(FEED.format(
        identifier=identifier,
        version=version,
        dependencies=dependencies,
        notes=f'{RELEASES}/tag/{TAG_PREFIX}{version}',
        oxt=f'{RELEASES}/download/{TAG_PREFIX}{version}/certimens-libreoffice-{version}.oxt',
    ), encoding='utf-8')
    return path


def main():
    parser = argparse.ArgumentParser(description='Builds dist/libreoffice.oxt.')
    parser.add_argument('--release', metavar=f'{TAG_PREFIX}X.Y.Z', default='',
                        help='version imposed by the tag; otherwise, this agent\'s last tag + commit')
    parser.add_argument('--feed', action='store_true',
                        help='write dist/update.xml only — what GitHub Pages serves, no package')
    options = parser.parse_args()

    if options.feed:
        version = released_version(options.release)
        if not version:
            # A checkout with no libreoffice tag has nothing to announce, and announcing 0.0.0
            # would offer every installed extension a downgrade.
            print('libreoffice: no release tag yet, no update feed written.')
            return
        print(f'{write_feed(version).relative_to(HERE.parent)} ({version})')
        return

    label = resolve_version(options.release)

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

    # The feed travels with the package it announces: a release builds both, and what reaches
    # GitHub Pages is the file this very build wrote, not one regenerated somewhere else.
    version = released_version(options.release)
    if version:
        print(f'{write_feed(version).relative_to(HERE.parent)} ({version})')


if __name__ == '__main__':
    main()
