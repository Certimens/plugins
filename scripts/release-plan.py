#!/usr/bin/env python3
"""What is left to release, agent by agent — and the go-ahead for a release started by hand.

"One agent, one tag, one version": each follows its own line, and an agent no commit has touched
is not resubmitted — a store reviews every package, and reviewing one identical to the last
costs a review for nothing. What remains, when the time comes to publish, is knowing **which of
the four moved**. No agent can tell: that would mean reading the three others, and following the
symlinks through which `ui.css`, `i18n.js`, the fonts and the icons reach three of them from
`browser/src/`. Hence this script, next to `check-coherence.py`: it belongs to no agent, and has
no dependency — standard library only.

It answers two questions:

1. **What is there to release?** For each of the four: its last tag, the commits that touched its
   package since (symlinks followed, so a modified `ui.css` shows up in all three), those that
   touched it without entering the package (tests, store listings), and what `CHANGELOG.md`
   already devotes to it.
2. **Can this one go out, now?** Given an agent, it refuses loudly — malformed version, tag
   already laid, version that does not move forward, missing changelog section, package
   unchanged since the last tag — and says "yes" only otherwise.

The report goes to standard output, in Markdown: the release workflow appends it to the run
summary, and that is where one reads what a run would do before running it for real.

    python3 scripts/release-plan.py                 # the state of the four
    python3 scripts/release-plan.py browser         # ... and the go-ahead for this one
    python3 scripts/release-plan.py browser 1.5.0   # ... with the version imposed
"""

import fnmatch
import importlib.util
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / 'CHANGELOG.md'

AGENTS = ('browser', 'word', 'libreoffice', 'vscode')

# What a package carries besides its agent's `src/`. All four ship `LICENSE` and `NOTICE` (AGPL:
# the licence travels with the code), and the `.vsix` also carries what the Marketplace reads.
# The build script itself does not travel — but it decides what enters the package and which
# version is written inside it: a commit touching it changes the package.
ALSO_PACKAGED = {
    'browser': (),
    'word': (),
    'libreoffice': (),
    'vscode': ('vscode/package.json', 'vscode/package.nls*.json', 'vscode/README.md'),
}
COMMON_PACKAGED = ('LICENSE', 'NOTICE', '{agent}/build.mjs', '{agent}/build.py')

# How many commits and files the report names before falling back to a count: a run summary is
# read, not scrolled through.
SHOWN = 10


def git(*args):
    """Git's output, empty when the command fails (no tag, no history)."""
    done = subprocess.run(('git', '-C', str(ROOT)) + args, check=False, capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else ''


def tracked_files():
    return git('ls-files').splitlines()


def package_paths(agent, files):
    """The repository files this agent's package is made of, symlinks followed.

    `word/src/ui.css` is a link to `browser/src/ui.css`: the latter is the path history knows,
    and therefore the one to watch to tell whether the Word add-in changed. A link to a
    directory (the fonts, the icons) yields its whole content.
    """
    prefix = f'{agent}/src/'
    paths = set()
    for path in files:
        if not path.startswith(prefix):
            continue
        target = (ROOT / path).resolve()
        try:
            inside = target.relative_to(ROOT).as_posix()
        except ValueError:
            continue  # outside the repository: nothing history can say about it
        if target.is_dir():
            paths.update(f for f in files if f.startswith(inside + '/'))
        else:
            paths.add(inside)
    for pattern in COMMON_PACKAGED + ALSO_PACKAGED[agent]:
        paths.update(fnmatch.filter(files, pattern.format(agent=agent)))
    return paths


def last_tag(agent):
    """This agent's last tag reachable from HEAD, the highest one by version."""
    tags = git('tag', '--list', f'{agent}-v*', '--merged', 'HEAD', '--sort=-v:refname').splitlines()
    return tags[0] if tags else ''


def version_of(tag):
    return tag.split('-v', 1)[1] if '-v' in tag else ''


def as_numbers(version):
    """The version as numbers, to compare it. A malformed version is worth zero."""
    parts = version.split('.')
    return tuple(int(part) for part in parts) if all(p.isdigit() for p in parts) else (0,)


def commits(since, paths):
    """The commits since that tag (or since the root) touching one of these paths."""
    span = f'{since}..HEAD' if since else 'HEAD'
    lines = git('log', '--format=%h %s', span, '--', *sorted(paths)).splitlines()
    return [line for line in lines if line]


def changelog_versions(agent, text):
    """The versions the changelog already devotes a section to, highest first."""
    found = re.findall(r'^##\s+%s\s+(\d+\.\d+\.\d+)\s*$' % re.escape(agent), text, re.MULTILINE)
    return sorted(set(found), key=as_numbers, reverse=True)


def next_version(version):
    """The next version suggested: a patch. Only a hint at the heading left to write."""
    numbers = as_numbers(version)
    if len(numbers) < 3:
        return '1.0.0'
    return '%d.%d.%d' % (numbers[0], numbers[1], numbers[2] + 1)


def survey(files, journal):
    """The state of the four: what moved, what the changelog says of it, what is left to do."""
    packaged = {agent: package_paths(agent, files) for agent in AGENTS}
    states = {}
    for agent in AGENTS:
        tag = last_tag(agent)
        package = commits(tag, packaged[agent])
        around = [c for c in commits(tag, {agent + '/'}) if c not in package]
        changed = git('log', '--format=', '--name-only', f'{tag}..HEAD' if tag else 'HEAD',
                      '--', *sorted(packaged[agent])).splitlines()
        # A changed file that several agents package is the one that calls for several tags.
        shared = sorted({path for path in changed if path
                         and sum(path in packaged[other] for other in AGENTS) > 1})
        written = changelog_versions(agent, journal)
        tagged = {version_of(t) for t in git('tag', '--list', f'{agent}-v*').splitlines()}
        ready = next((v for v in written if v not in tagged), '')
        states[agent] = {
            'tag': tag,
            'version': version_of(tag),
            'date': git('log', '-1', '--format=%ad', '--date=short', tag) if tag else '',
            'package': package,
            'around': around,
            'shared': shared,
            'ready': ready,
            'owners': {path: [a for a in AGENTS if path in packaged[a]] for path in shared},
        }
    return states


def render(states, agent=None):
    """The report, in Markdown: the release run's summary, and the first thing read there."""
    out = ['### What is left to release', '',
           '| Agent | Last tag | Since, in the package | Around | Changelog |',
           '| --- | --- | --- | --- | --- |']
    for name in AGENTS:
        state = states[name]
        tag = f'`{state["tag"]}` ({state["date"]})' if state['tag'] else '— never released'
        count = len(state['package'])
        package = f'**{count} commit{"s" if count > 1 else ""}**' if count else '—'
        ready = state['ready']
        if ready:
            journal = f'`## {name} {ready}` → **ready**'
        elif state['package']:
            journal = f'to write (`## {name} {next_version(state["version"])}`?)'
        else:
            journal = '—'
        out.append(f'| `{name}` | {tag} | {package} | {len(state["around"]) or "—"} | {journal} |')
    out.append('')

    # One block per agent, or only the chosen one: a release reads about what it publishes.
    for name in (AGENTS if agent is None else (agent,)):
        state = states[name]
        out.append(f'#### `{name}`')
        out.append('')
        if not state['package']:
            out.append('Nothing in its package since '
                       + (f'`{state["tag"]}`.' if state['tag'] else 'the repository\'s root commit.')
                       + ' Republishing it would have its stores review a package they already have.')
            out.append('')
            continue
        out.append('What changed in the package since '
                   + (f'`{state["tag"]}`:' if state['tag'] else 'the repository\'s root commit:'))
        out.append('')
        for line in state['package'][:SHOWN]:
            out.append(f'- {line}')
        if len(state['package']) > SHOWN:
            out.append(f'- … and {len(state["package"]) - SHOWN} more')
        out.append('')
        if state['shared']:
            out.append('**Shared** files touched — one tag per agent concerned:')
            out.append('')
            for path in state['shared'][:SHOWN]:
                others = [o for o in state['owners'][path] if o != name]
                out.append(f'- `{path}` → also in {", ".join(f"`{o}`" for o in others)}')
            out.append('')
        if state['around']:
            out.append(f'{len(state["around"])} other commit(s) touch it without entering its '
                       'package (tests, store listings, tooling): on their own they do not '
                       'justify a new version.')
            out.append('')
    return '\n'.join(out)


def refuse(report, reason):
    """A refusal is read in the run summary as well as in the log: both, then."""
    print(report)
    print()
    print('### ❌ Nothing is published')
    print()
    print(reason)
    print(reason, file=sys.stderr)
    return 1


def resolve(states, agent, version, report):
    """The go-ahead, or the refusal: what it takes before laying an agent's tag."""
    state = states[agent]
    # No version given: the changelog decides, since it is written before the tag anyway.
    if not version:
        version = state['ready']
        if not version:
            return refuse(report, f'`{agent}`: no version to release in `CHANGELOG.md`.\n\n'
                          'The version\'s section is written **before** the tag: take out of '
                          f'"Non publié" what touches `{agent}`, make it a '
                          f'`## {agent} {next_version(state["version"])}` section carrying the '
                          'two bilingual sentences the stores ask for, commit, then run again. '
                          'Or give the version by hand in the form.')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        return refuse(report, f'Version "{version}": expected as X.Y.Z.')
    tag = f'{agent}-v{version}'
    if git('tag', '--list', tag):
        return refuse(report, f'Tag `{tag}` already exists: a released version is not laid '
                      'again. Release the next one.')
    if state['tag'] and as_numbers(version) <= as_numbers(state['version']):
        return refuse(report, f'`{version}` does not move forward from `{state["tag"]}`: a '
                      'store refuses a version that goes backwards or repeats itself.')
    # The refusal that pays for itself: a store reviews every submission, by hand on AMO and
    # AppSource. The hand-laid tag stays as the way out when it is wanted anyway.
    if not state['package']:
        return refuse(report, f'`{agent}`: no commit touches its package since '
                      f'`{state["tag"]}`. Resubmitting it would have its stores review a package '
                      'identical to the previous one — every submission costs a review. If it is '
                      'wanted anyway (a package rejected by a store, say), lay the tag by hand: '
                      '`git tag ' + tag + ' && git push origin ' + tag + '`.')
    body = section_of_changelog(agent, version)
    if not body:
        return refuse(report, f'`CHANGELOG.md`: no `## {agent} {version}` section.\n\n'
                      'The release makes its notes out of it, and the store takes its two '
                      '"What\'s new" sentences there: write it, commit, then run again.')

    print(report)
    print()
    print(f'### ✅ `{tag}`')
    print()
    print('Release notes, as `CHANGELOG.md` gives them:')
    print()
    print(body)
    emit(agent=agent, version=version, tag=tag)
    return 0


def section_of_changelog(agent, version):
    """The changelog section, read by the script that already serves it to the release.

    Loaded from its file rather than copied here: there is only one way to cut the changelog up,
    and the release is what defines it.
    """
    path = ROOT / 'scripts' / 'changelog-section.py'
    # Nothing in this script leaves a trace in the repository: no __pycache__ beside its peers.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('changelog_section', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.section(CHANGELOG.read_text(encoding='utf-8'), agent, version)


def emit(**values):
    """What the workflow reads from this script: the step's outputs, when there is a step."""
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as handle:
        handle.writelines(f'{key}={value}\n' for key, value in values.items())


def main(argv):
    if len(argv) > 3:
        print('usage: release-plan.py [<agent> [version]]', file=sys.stderr)
        return 2
    agent = argv[1] if len(argv) > 1 else None
    version = argv[2] if len(argv) > 2 else ''
    if agent is not None and agent not in AGENTS:
        print(f'Unknown agent "{agent}": {", ".join(AGENTS)}.', file=sys.stderr)
        return 2

    states = survey(tracked_files(), CHANGELOG.read_text(encoding='utf-8'))
    report = render(states, agent)
    if agent is None:
        print(report)
        return 0
    return resolve(states, agent, version, report)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
