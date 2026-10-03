#!/usr/bin/env python3
"""An agent's section in CHANGELOG.md, as a release publishes it.

A `<agent>-vX.Y.Z` tag publishes one agent and nothing else, and the release it creates has to
say what that version changes — for the student reading it on GitHub, and for the store, which
demands its two "What's new" sentences. The commit list does not say that: it says what the
repository did, not what the agent brings, and it mixes all four.

This script reads the "## <agent> <version>" section of the changelog and writes it to standard
output. It **fails loudly** if it is not there, and that is its whole point: laying a tag
without having split up the "Non publié" section becomes a release error rather than a release
with empty notes, discovered while filling in the store listing.

It belongs to no agent — it reads the repository's changelog — hence its place in `scripts/`. No
dependency: standard library only.

    python3 scripts/changelog-section.py browser 1.5.0       # or: the release, on a tag
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / 'CHANGELOG.md'


def section(text, agent, version):
    """The body of "## <agent> <version>", up to the next heading of the same level."""
    heading = re.compile(r'^##\s+%s\s+%s\s*$' % (re.escape(agent), re.escape(version)), re.MULTILINE)
    start = heading.search(text)
    if not start:
        return None
    rest = text[start.end():]
    following = re.search(r'^##\s', rest, re.MULTILINE)
    return (rest[:following.start()] if following else rest).strip()


def main(argv):
    if len(argv) != 3:
        print('usage: changelog-section.py <agent> <version>', file=sys.stderr)
        return 2
    agent, version = argv[1], argv[2]
    body = section(CHANGELOG.read_text(encoding='utf-8'), agent, version)
    if not body:
        print(f'CHANGELOG.md: no "## {agent} {version}" section.\n\n'
              f'A version going out says what it changes: open the changelog, take out of\n'
              f'"Non publié" what touches the "{agent}" agent, make it that section, and write\n'
              f'in it the two bilingual sentences the store asks for its "What\'s new". Then\n'
              f'release again.', file=sys.stderr)
        return 1
    print(body)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
