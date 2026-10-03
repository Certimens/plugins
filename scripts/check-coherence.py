#!/usr/bin/env python3
"""What binds the four agents together, checked mechanically.

Each agent has its linters and its tests, and none of them can see the three others: the
invariants that cross the repository — "one definition, four implementations" — were until now
held by review alone. These are checkable, and are checked here:

1. **The shared constants** (`docs/mesures.md`, section *Constantes communes*) have the same
   value in all four sensors, units included: `IDLE_FLUSH_MS` equals `IDLE_FLUSH_S`. The
   documentation's table is the reference, and it is what the code is compared against: a value
   changed in one sensor and nowhere else shows up here.
2. **The vocabulary of the measurement body** (`docs/mesures.md`, *Le déroulé* and *Ce que seul
   le capteur sait classer*): the kinds of run a sensor writes and the keys of `counts` it
   fills are the documented ones, and the only ones an agent leaves out are the accepted gaps,
   named below. The engine refuses a kind or a key it does not know — the whole window with it
   — so a word spelt differently in one agent, or added to three out of four, shows up here
   rather than as a refusal on a student's machine.
3. **What the four share arrives through symlinks, never through a copy.** A link replaced by a
   copy passes every linter and every test, and the two files then diverge without a word.
4. **The default engine address** is the same in the four clients. Each agent is standalone and
   declares it at home; nothing, until now, would say that one of them sends elsewhere — and the
   divergence would only show on the agent of a student who no longer reaches anything.
5. **Why a window was sealed** (`docs/mesures.md`, section *Pourquoi la fenêtre s'est fermée*):
   every trigger an agent can flush on is translated into the shared vocabulary of `why`, and
   nothing outside that vocabulary is ever sent. The word is mandatory: a trigger added to a
   sensor and forgotten in its table seals a window the engine refuses.
6. **The rule on where the token may travel** (`docs/moteur.md`, *L'adresse du moteur*): the
   pattern naming the hosts a plain `http:` engine address may use is the same in the four
   clients, character for character. It is the one rule that decides whether an API token that
   never expires crosses the network in the clear, it is written four times in two languages,
   and an agent loosened on its own would be a hole with nothing anywhere to say so.
7. **The numbers of the protocol** (`docs/mesures.md`, *Les nombres du protocole*): the edges of
   the two rhythm histograms, the size of a batch and the ceiling of the `kept` comparison. The
   engine holds the same edges, and a histogram counted on other ones is a different
   measurement under the same name, silently wrong.
8. **What a sensor cannot see is said once** (`unseen`): the one agent that cannot resolve short
   silences declares it in its client, and no other does.

This script belongs to no agent — it compares them — hence its place in `scripts/`. It has no
dependency: standard library only, like the LibreOffice agent.

    python3 scripts/check-coherence.py      # or: make check, at the root
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / 'docs' / 'mesures.md'
ENGINE_DOC = ROOT / 'docs' / 'moteur.md'

# Each agent's sensor: where the shared constants and the window being sent live.
SENSORS = {
    'navigateur': ROOT / 'browser' / 'src' / 'content.js',
    'word': ROOT / 'word' / 'src' / 'sensor.js',
    'vscode': ROOT / 'vscode' / 'src' / 'sensor.js',
    'libreoffice': ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'measure.py',
}

# Each agent's engine client: where the default address lives. It is not the sensor — the
# extension declares it in the file its service worker and its pages share, the Word task pane in
# its agent, the two others in their client.
ENGINE_CLIENTS = {
    'navigateur': ROOT / 'browser' / 'src' / 'constants.js',
    'word': ROOT / 'word' / 'src' / 'agent.js',
    'vscode': ROOT / 'vscode' / 'src' / 'engine.js',
    'libreoffice': ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'engine.py',
}

# Each agent's engine client proper: what builds the request and sends a batch. For three of
# them it is the file above; the extension's is its service worker.
CLIENT_SOURCES = dict(ENGINE_CLIENTS, navigateur=ROOT / 'browser' / 'src' / 'background.js')

# The accepted gaps of `docs/mesures.md`, in the vocabulary of the body: the kinds of run and
# the keys of `counts` an agent does not write, because its host does not let it see the
# gesture. A word missing from an agent without appearing here is a forgotten one, not a gap —
# and a word present although listed here is a gap that has closed, to be removed from the
# documentation and from this script.
RUN_GAPS = {
    # `move` is a cursor move that is *not* a keystroke for the sensor: here and in Writer the
    # keys are seen, so a move from the keyboard is a `nav` keystroke.
    'navigateur': {'move'},
    # Writer's corrector lives in a window the sensor does not intercept.
    'libreoffice': {'move', 'fix'},
    # Office delivers differences of text and selection changes: no key (so no `nav`), no
    # click told from another move, no clipboard event, no undo, no corrector.
    'word': {'nav', 'click', 'copy', 'undo', 'fix'},
    # The editor gives document changes: a move from the keyboard is seen without its key
    # (`move`, not `nav`), and neither the clipboard nor a corrector is.
    'vscode': {'nav', 'copy', 'fix'},
}
COUNT_GAPS = {
    # Office signals neither the document losing focus nor the return to it.
    'word': {'exits', 'back_keys', 'back_chars'},
    'vscode': set(),
    'navigateur': set(),
    'libreoffice': set(),
}

# What a sensor declares it cannot observe (`unseen`), agent by agent. One word exists.
UNSEEN = {
    'word': ['hesitations'],
    'vscode': [],
    'navigateur': [],
    'libreoffice': [],
}

# The constants an agent does not declare, because the rule they bound does not exist there.
# These are the same accepted gaps as above, seen from the constants' side.
CONSTANT_GAPS = {
    # Word does not see keystrokes: it has no flight times to bound. Nor does it see the document
    # losing focus, hence no return to date a paste from either.
    # And it cannot resolve a short silence: it holds its own, higher floor
    # (`SILENCE_RESOLUTION_MS`) instead of the shared one.
    'word': {'FLIGHT_MAX_MS', 'RETURN_WINDOW_MS', 'GAP_MIN_MS'},
    # VS Code does not recognise a restitution: nothing to hash, to keep, or to compare.
    'vscode': {'SHINGLE_WORDS', 'SELF_PASTE_RATIO', 'SELF_PASTE_TTL_MS', 'SELF_PASTE_MAX_COPIES'},
    'navigateur': set(),
    'libreoffice': set(),
}

# The constants a single agent declares, for a reason that belongs to it alone.
LOCAL_CONSTANTS = {'SELECTION_ECHO_MS'}

# The numbers of the protocol that are not single shared values, or do not live in a sensor:
# the edges of the two histograms, declared beside the sensor that fills them, the size of a
# batch, declared beside the client that sends it, and the ceiling of the `kept` comparison,
# which a sensor may lower. (`TIMELINE_MAX_RUNS` and `SESSION_ID_BYTES` are plain numbers in
# the four sensors: the table of shared constants holds them.)
PROTOCOL_SECTION = 'Les nombres du protocole'
RUNS_SECTION = 'Le déroulé'
COUNTS_SECTION = 'Ce que seul le capteur sait classer'
HISTOGRAM_EDGES = ('FLIGHT_BINS_MS', 'DWELL_BINS_MS')
# The histograms an agent cannot fill, seen from the constants' side: Word sees no keystroke,
# and neither Word nor VS Code sees a key released.
HISTOGRAM_GAPS = {
    'word': {'FLIGHT_BINS_MS', 'DWELL_BINS_MS'},
    'vscode': {'DWELL_BINS_MS'},
    'navigateur': set(),
    'libreoffice': set(),
}
BATCH_CONSTANT = 'BATCH_MAX_WINDOWS'
KEPT_CONSTANT = 'TEXT_KEPT_MAX_WORDS'


def base_name(name):
    """A constant's name without its unit: `IDLE_FLUSH_MS` and `IDLE_FLUSH_S` are the same one."""
    return re.sub(r'_(MS|S)$', '', name)


def fail(problems, message):
    problems.append(message)


# --- reading the documentation -------------------------------------------------------------

def doc_tables(text):
    """The rows of the Markdown tables, by section (`## Heading`)."""
    sections = {}
    current = None
    for line in text.splitlines():
        heading = re.match(r'^##\s+(.*)', line)
        if heading:
            current = heading.group(1).strip()
            sections[current] = []
        elif current and line.startswith('|'):
            sections[current].append([cell.strip() for cell in line.strip('|').split('|')])
    return sections


def to_seconds(name, value):
    """A constant's value brought back to a common unit, from the suffix of its name.

    `IDLE_FLUSH_MS` and `IDLE_FLUSH_S` name the same rule in two units: comparing them means
    bringing them back to one. A constant with no suffix (`FLUSH_KEYSTROKES`, `SHINGLE_WORDS`)
    has no unit and is compared as it is.
    """
    if name.endswith('_MS'):
        return value / 1000
    return value


def parse_documented_constants(rows, problems):
    """The *Constantes communes* table: one or two spellings of one name, one or two values.

    `| FLUSH_KEYSTROKES / NAV_STEPS_AWAY | 200 / 2 |` names two distinct constants on one row;
    `| IDLE_FLUSH_MS / IDLE_FLUSH_S | 2 s |` names two spellings of a single one.
    """
    documented = {}
    for cells in rows:
        if len(cells) < 2 or cells[0].startswith('---') or not cells[0].startswith('`'):
            continue
        names = re.findall(r'`([A-Z][A-Z0-9_]*)`', cells[0])
        values = re.findall(r'(\d+(?:[.,]\d+)?)\s*(ms|s)?', cells[1])
        values = [(float(number.replace(',', '.')), unit) for number, unit in values if number]
        if not names or not values:
            continue
        pairs = zip(names, values) if len(names) == len(values) else ((name, values[0]) for name in names)
        for name, (number, unit) in pairs:
            # The unit written in the documentation wins; without one, it is the unit the name
            # carries (`FLIGHT_MAX_MS | 800` is 800 ms).
            if unit == 's':
                canonical = number
            elif unit == 'ms':
                canonical = number / 1000
            else:
                canonical = to_seconds(name, number)
            if name in documented and documented[name] != canonical:
                fail(problems, f'docs/mesures.md: {name} appears twice there with two values')
            documented[name] = canonical
    return documented


def parse_documented_words(rows):
    """A vocabulary table: one word per row, alone and in backticks in the first column."""
    words = []
    for cells in rows:
        found = re.match(r'^`([a-z][a-z0-9_]*)`$', cells[0]) if cells else None
        if found:
            words.append(found.group(1))
    return words


# --- reading the code ----------------------------------------------------------------------

# A value may be written as factors, so that the unit can be read: `10 * 60 * 1000`.
CONSTANT = re.compile(r'^(?:const\s+)?([A-Z][A-Z0-9_]*)\s*=\s*'
                      r'(\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?)*)\s*[;#\n]', re.MULTILINE)


def constants_of(path):
    """The numeric constants declared at the top of a sensor, whatever its language."""
    found = {}
    for name, expression in CONSTANT.findall(path.read_text(encoding='utf-8')):
        product = 1.0
        for factor in expression.split('*'):
            product *= float(factor.strip())
        found[name] = product
    return found


def block_after(text, opening):
    """The body of a `{...}` literal, counted brace by brace."""
    start = text.find(opening)
    if start < 0:
        return ''
    start += len(opening) - 1
    depth = 0
    for index in range(start, len(text)):
        if text[index] == '{':
            depth += 1
        elif text[index] == '}':
            depth -= 1
            if depth == 0:
                return text[start:index]
    return ''


# Where a kind of run is named in a sensor, whatever its language and its style: the head of a
# run written as a list (`['gap', ms]`, never a list of strings), a `RUN_X = 'x'` constant, a
# call to a function whose name ends in `run` (`addRun('type', …)`, `this.run('click', …)`), and
# a `kind` given a literal. These find the words an agent uses *as kinds*, which is what lets a
# word outside the vocabulary be seen; whether a documented kind is present at all is asked more
# loosely, of the whole file (see check_run_kinds).
KIND_SITES = (
    re.compile(r"""\[\s*['"]([a-z_]+)['"]\s*,\s*[^'"\s\]]"""),
    re.compile(r"""^RUN_[A-Z_]+\s*=\s*['"]([a-z_]+)['"]""", re.MULTILINE),
    re.compile(r"""[Rr]un\(\s*['"]([a-z_]+)['"]"""),
    re.compile(r"""\bkind:\s*['"]([a-z_]+)['"]"""),
)


def kinds_named_in(text):
    found = set()
    for site in KIND_SITES:
        found |= set(site.findall(text))
    return found


def counts_of(path):
    """The keys of `counts` a sensor fills: the literal it builds, and any key added after."""
    text = path.read_text(encoding='utf-8')
    names = set()
    for opening in ('counts: {', "'counts': {", '"counts": {', 'counts = {'):
        body = block_after(text, opening)
        names |= set(re.findall(r"""^\s*['"]?([a-z][a-z0-9_]*)['"]?\s*:""", body, re.MULTILINE))
    names |= set(re.findall(r"counts\.([a-z][a-z0-9_]*)\s*=(?!=)", text))
    names |= set(re.findall(r"""counts\[['"]([a-z][a-z0-9_]*)['"]\]\s*=""", text))
    return names


# --- the checks --------------------------------------------------------------------

def check_constants(documented, problems):
    for agent, path in SENSORS.items():
        found = constants_of(path)
        for name, expected in documented.items():
            # The gap is about the rule, not the spelling: `SELF_PASTE_TTL_MS` and
            # `SELF_PASTE_TTL_S` name the same one, and one of them is enough to write it.
            if base_name(name) in {base_name(gap) for gap in CONSTANT_GAPS[agent]}:
                continue
            # A constant may only exist in the other unit's spelling.
            base = base_name(name)
            spellings = [key for key in found if base_name(key) == base]
            if not spellings:
                fail(problems, f'{agent}: {name} (or its {base}_S/_MS spelling) is missing from {path.relative_to(ROOT)}')
                continue
            for spelling in spellings:
                actual = to_seconds(spelling, found[spelling])
                if abs(actual - expected) > 1e-9:
                    fail(problems, f'{agent}: {spelling} = {found[spelling]:g} '
                                   f'instead of {expected:g} (docs/mesures.md)')
        for name in found:
            base = base_name(name)
            known = {base_name(key) for key in documented}
            if base not in known and name not in LOCAL_CONSTANTS and name.startswith(
                    ('FLUSH', 'IDLE', 'PAUSE', 'HESITATION', 'GAP', 'ACTIVE', 'INJECTION', 'FLIGHT_MAX',
                     'SHINGLE', 'SELF_PASTE', 'RETURN', 'ERASE', 'NAV', 'TIMELINE_MAX', 'SESSION_ID')):
                fail(problems, f'{agent}: {name} looks like a shared constant, '
                               f'but is not in the table of docs/mesures.md')


def check_run_kinds(documented, problems):
    """Each sensor writes the documented kinds of run, less its accepted gaps, and no other.

    A kind is a word of a closed vocabulary: the engine refuses a window holding one it does not
    know. An agent that spelt one differently would have every window refused; one that stopped
    writing a kind would silently stop reporting the gesture — which, on the engine's side, looks
    exactly like a student who never makes it.
    """
    known = set(documented)
    for agent, path in SENSORS.items():
        text = path.read_text(encoding='utf-8')
        named = kinds_named_in(text)
        for name in sorted(named - known):
            fail(problems, f'{agent}: writes runs of kind "{name}", which the table of '
                           f'docs/mesures.md ("{RUNS_SECTION}") does not document')
        present = {name for name in known if re.search(rf"""['"]{name}['"]""", text)}
        for name in sorted(known - present - RUN_GAPS[agent]):
            fail(problems, f'{agent}: writes no "{name}" run, and that is not an accepted gap '
                           f'(docs/mesures.md, "Écarts assumés")')
        for name in sorted(RUN_GAPS[agent] & named):
            fail(problems, f'{agent}: writes "{name}" runs, which the accepted gaps say it cannot — '
                           f'the gap is to be removed from docs/mesures.md and from this script')
    for agent, gaps in RUN_GAPS.items():
        for name in sorted(gaps - known):
            fail(problems, f'scripts/check-coherence.py: the gap "{name}" of {agent} is not a documented kind')


def check_counts(documented, problems):
    """Each sensor fills the documented keys of `counts`, less its accepted gaps, and no other.

    A key a sensor cannot measure is absent, never zero — the engine draws no measurement from
    an absent key, and would average a zero. So a gap is a key *not written*, and a key written
    by an agent whose gap it is means the agent is sending zeros for something it does not see.
    """
    known = set(documented)
    for agent, path in SENSORS.items():
        filled = counts_of(path)
        if not filled:
            fail(problems, f'{agent}: no `counts` block found in {path.relative_to(ROOT)}')
            continue
        for name in sorted(filled - known):
            fail(problems, f'{agent}: fills counts.{name}, which the table of docs/mesures.md '
                           f'("{COUNTS_SECTION}") does not document')
        for name in sorted(known - filled - COUNT_GAPS[agent]):
            fail(problems, f'{agent}: does not fill counts.{name}, and that is not an accepted gap '
                           f'(docs/mesures.md, "Écarts assumés")')
        for name in sorted(COUNT_GAPS[agent] & filled):
            fail(problems, f'{agent}: fills counts.{name}, which the accepted gaps say is absent — '
                           f'the gap is to be removed from docs/mesures.md and from this script')


def check_unseen(problems):
    """What a sensor cannot observe is declared by the agent that cannot, and by no other.

    `unseen: ["hesitations"]` tells the engine to draw no hesitation from this agent's silences.
    Declared by an agent that does resolve them, it would erase a measurement it takes; missing
    from the one that does not, every one of its students would read as never hesitating.
    """
    declaration = re.compile(r"^(?:const\s+)?UNSEEN\s*=\s*[\[(]([^\])]*)[\])]", re.MULTILINE)
    for agent, path in CLIENT_SOURCES.items():
        text = path.read_text(encoding='utf-8')
        found = declaration.search(text)
        declared = re.findall(r"""['"]([a-z_]+)['"]""", found.group(1)) if found else []
        if declared != UNSEEN[agent]:
            fail(problems, f'{agent}: declares unseen = {declared} in {path.relative_to(ROOT)} '
                           f'where {UNSEEN[agent]} is expected (docs/mesures.md, "Écarts assumés")')
        if not UNSEEN[agent] and re.search(r"""\bunseen\b\s*[:=]|['"]unseen['"]""", text):
            fail(problems, f'{agent}: sends `unseen` although it has nothing to declare')


def parse_documented_lists(rows):
    """The table of *Les nombres du protocole*: a name, and one or several whole numbers."""
    documented = {}
    for cells in rows:
        if len(cells) < 2 or not cells[0].startswith('`'):
            continue
        name = re.match(r'^`([A-Z][A-Z0-9_]*)`$', cells[0])
        numbers = [int(number) for number in re.findall(r'\d+', cells[1])]
        if name and numbers:
            documented[name.group(1)] = numbers
    return documented


def list_constant_of(path, name):
    """A constant declared as a list of whole numbers — a JavaScript array, a Python tuple."""
    found = re.search(rf'^(?:const\s+)?{name}\s*=\s*[\[(]([^\])]*)[\])]', path.read_text(encoding='utf-8'),
                      re.MULTILINE)
    if not found:
        return None
    return [int(number) for number in re.findall(r'\d+', found.group(1))]


def check_protocol_numbers(sections, problems):
    """The histograms have the same edges four times, and a batch the same size.

    A histogram is only readable against its edges, and they travel nowhere: the body carries
    up to fourteen counts and the engine reads them on the edges it holds. An agent that moved one
    would send a distribution shifted by a bin, of the right length, that nothing refuses.
    """
    documented = parse_documented_lists(sections.get(PROTOCOL_SECTION, []))
    for name in (*HISTOGRAM_EDGES, BATCH_CONSTANT, KEPT_CONSTANT):
        if name not in documented:
            fail(problems, f'docs/mesures.md: {name} is not in the table of "{PROTOCOL_SECTION}"')
    for agent, path in SENSORS.items():
        for name in HISTOGRAM_EDGES:
            if name not in documented:
                continue
            found = list_constant_of(path, name)
            if name in HISTOGRAM_GAPS[agent]:
                if found is not None:
                    fail(problems, f'{agent}: declares {name}, which the accepted gaps say it cannot '
                                   f'fill — the gap is to be removed from docs/mesures.md and from this script')
                continue
            if found is None:
                fail(problems, f'{agent}: {name} is missing from {path.relative_to(ROOT)}')
            elif found != documented[name]:
                fail(problems, f'{agent}: {name} = {found} instead of {documented[name]} (docs/mesures.md)')
    if BATCH_CONSTANT in documented:
        for agent, path in CLIENT_SOURCES.items():
            found = constants_of(path).get(BATCH_CONSTANT)
            if found is None:
                fail(problems, f'{agent}: {BATCH_CONSTANT} is missing from {path.relative_to(ROOT)}')
            elif [int(found)] != documented[BATCH_CONSTANT]:
                fail(problems, f'{agent}: {BATCH_CONSTANT} = {found:g} instead of '
                               f'{documented[BATCH_CONSTANT][0]} (docs/mesures.md)')
    # The ceiling of the word-by-word comparison behind `kept`: a sensor may stop lower — the
    # comparison runs on the student's thread — never higher than the protocol does.
    if KEPT_CONSTANT in documented:
        for agent, path in SENSORS.items():
            found = constants_of(path).get(KEPT_CONSTANT)
            if found is None:
                fail(problems, f'{agent}: {KEPT_CONSTANT} is missing from {path.relative_to(ROOT)}')
            elif found > documented[KEPT_CONSTANT][0]:
                fail(problems, f'{agent}: {KEPT_CONSTANT} = {found:g}, above the ceiling of '
                               f'{documented[KEPT_CONSTANT][0]} (docs/mesures.md)')


# The addresses each agent declares at home, and what each one is called when it diverges. Both
# live in the agent's engine client: the engine is what one talks to, the release notes what one
# sends the student to after an update.
SHARED_URLS = {
    'DEFAULT_ENGINE_URL': 'default engine address',
    'RELEASE_NOTES_URL': 'release notes address',
}


def url_pattern(name):
    return re.compile(rf"^(?:const\s+)?{name}\s*=\s*['\"]([^'\"]+)['\"]", re.MULTILINE)


def check_shared_urls(problems):
    """The addresses declared four times are worth the same thing four times.

    Each agent is a standalone project, written in its own language: a constant cannot be shared
    through a symlink between JavaScript and Python, and this is the only thing binding the four
    declarations. An agent left on an old address would fail nowhere — it would reach a host
    that no longer answers, on the student's machine, and nowhere else.
    """
    for name, label in SHARED_URLS.items():
        pattern = url_pattern(name)
        found = {}
        for agent, path in ENGINE_CLIENTS.items():
            match = pattern.search(path.read_text(encoding='utf-8'))
            if not match:
                fail(problems, f'{agent}: {name} not found in '
                               f'{path.relative_to(ROOT)} — the {label} has moved')
                continue
            found.setdefault(match.group(1), []).append(agent)
        if len(found) > 1:
            divergence = '; '.join(f'{url} ({", ".join(sorted(agents))})' for url, agents in sorted(found.items()))
            fail(problems, f'{label}: {divergence}')


# Each client declares the hosts a plain `http:` engine address may name, as one pattern on one
# line: a JavaScript literal in three of them, an `re.compile` in the fourth. What is compared is
# what sits between the first `^` and the last `$` of that line, which is the pattern itself in
# both languages.
LOCAL_HOST_RULE = re.compile(r'^(?:const\s+)?LOCAL_ENGINE_HOST\s*=.*?(\^.*\$)', re.MULTILINE)


def check_engine_url_rule(problems):
    """`http:` is accepted on the same hosts in the four agents, and nowhere else.

    This is the rule that decides whether an API token **that never expires** crosses the
    network in the clear. It is written four times because the agents share no code, it is the
    kind of rule somebody widens locally to unblock one deployment, and an agent that accepted
    one host more than the three others would say so nowhere.
    """
    found = {}
    for agent, path in ENGINE_CLIENTS.items():
        match = LOCAL_HOST_RULE.search(path.read_text(encoding='utf-8'))
        if not match:
            fail(problems, f'{agent}: LOCAL_ENGINE_HOST not found in '
                           f'{path.relative_to(ROOT)} — nothing says where an http engine may live')
            continue
        found.setdefault(match.group(1), []).append(agent)
    if len(found) > 1:
        divergence = '; '.join(f'{", ".join(sorted(agents))}: {pattern}'
                               for pattern, agents in sorted(found.items()))
        fail(problems, f'the hosts an http engine address may name differ — {divergence}')


# How each agent names itself to the engine. The header is the same for the four, the kind is
# each one's own, and both live beside the client that sets them.
AGENT_SOURCES = CLIENT_SOURCES

# The kind each agent must declare. It is the engine's vocabulary, so it is written here rather
# than derived from the folder name: the day one of them is renamed on disk, what reaches the
# engine must not change with it.
AGENT_KINDS = {
    'navigateur': 'browser',
    'word': 'word',
    'vscode': 'vscode',
    'libreoffice': 'libreoffice',
}

AGENT_DECLARATION = {
    'AGENT_HEADER': 'the header an agent names itself in',
    'AGENT_VERSION_MAX': 'the length a declared build may reach',
}


def check_agent_declaration(problems):
    """The four agents name themselves to the engine in one way, and say which one they are.

    The header is what lets a reader of a copy be told it was written in Word rather than in a
    browser, and what the engine flags the absence of. An agent that spelled it differently would
    be reported as declaring nothing — on every window, of every student using it — and the only
    trace would be a signal that fires on everything and therefore says nothing.

    The kinds, on the contrary, must all differ: two agents sharing one would be indistinguishable
    in the very field that exists to tell them apart.
    """
    for name, label in AGENT_DECLARATION.items():
        pattern = re.compile(rf"^(?:const\s+)?{name}\s*=\s*['\"]?(.+?)['\"]?;?\s*$", re.MULTILINE)
        found = {}
        for agent, path in AGENT_SOURCES.items():
            match = pattern.search(path.read_text(encoding='utf-8'))
            if not match:
                fail(problems, f'{agent}: {name} not found in '
                               f'{path.relative_to(ROOT)} — nothing says {label}')
                continue
            found.setdefault(match.group(1).strip(), []).append(agent)
        if len(found) > 1:
            divergence = '; '.join(f'{value} ({", ".join(sorted(agents))})' for value, agents in sorted(found.items()))
            fail(problems, f'{label} differs — {divergence}')

    kind = re.compile(r"^(?:const\s+)?AGENT_KIND\s*=\s*['\"]([a-z]+)['\"]", re.MULTILINE)
    declared = {}
    for agent, path in AGENT_SOURCES.items():
        match = kind.search(path.read_text(encoding='utf-8'))
        if not match:
            fail(problems, f'{agent}: AGENT_KIND not found in '
                           f'{path.relative_to(ROOT)} — the agent does not say which one it is')
            continue
        declared[agent] = match.group(1)
        if match.group(1) != AGENT_KINDS[agent]:
            fail(problems, f'{agent}: declares itself "{match.group(1)}" '
                           f'where the engine knows "{AGENT_KINDS[agent]}"')
    kinds = list(declared.values())
    shared = {value for value in kinds if kinds.count(value) > 1}
    for value in sorted(shared):
        agents = sorted(a for a, v in declared.items() if v == value)
        fail(problems, f'"{value}" is declared by several agents ({", ".join(agents)})')


# What a document carries inside itself. The Word add-in and the LibreOffice extension write
# these two custom properties into the very same file — a .docx opened in both, a .odt saved as
# one — and the names are the whole of it: spelt differently on one side, each agent reads a
# file the other wrote as a file carrying nothing, opens a second record for it, and splits one
# piece of work in two without a word anywhere.
DOCUMENT_CARRIERS = {
    'word': ROOT / 'word' / 'src' / 'agent.js',
    'libreoffice': ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'sensor.py',
}

CARRIED_PROPERTIES = {
    'DOCUMENT_ID_PROPERTY': 'the property a file keeps its identity in',
    'ENGINE_DOCUMENT_PROPERTY': 'the property a file names its engine document in',
}

# The agents that read an engine document id from somewhere other than their own storage: out of
# a message (the extension's service worker) or out of the document itself (Word, LibreOffice).
# VS Code has none — its ids come from its own storage and nowhere else — so it is absent here
# rather than carrying a rule it never applies.
ENGINE_ID_SOURCES = {
    'navigateur': ROOT / 'browser' / 'src' / 'background.js',
    'word': ROOT / 'word' / 'src' / 'agent.js',
    'libreoffice': ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'engine.py',
}

ENGINE_ID_RULE = re.compile(r'^(?:const\s+)?ENGINE_ID\s*=.*?(\^.*\$)', re.MULTILINE)


def check_document_identity(problems):
    """A file says who it is, and which engine document it feeds, in one vocabulary.

    Two things are compared here. The **names** of the properties, because they are what two
    agents meet in: one piece of work written in Word and finished in Writer stays one record
    only as long as both read the same two names out of the file.

    And the **shape** an engine document id must have before it is interpolated into an API
    path. This one is a security rule: that id is the only value these agents take from a file —
    or, for the extension, from a message — and nobody else has checked it. A slash or a `..` in
    it is no longer an id, it is another route, called with a token that never expires. An agent
    that accepted one character more than the others would say so nowhere.
    """
    for name, label in CARRIED_PROPERTIES.items():
        pattern = re.compile(rf"^(?:const\s+)?{name}\s*=\s*['\"](.+?)['\"];?\s*$", re.MULTILINE)
        found = {}
        for agent, path in DOCUMENT_CARRIERS.items():
            match = pattern.search(path.read_text(encoding='utf-8'))
            if not match:
                fail(problems, f'{agent}: {name} not found in '
                               f'{path.relative_to(ROOT)} — nothing says {label}')
                continue
            found.setdefault(match.group(1), []).append(agent)
        if len(found) > 1:
            divergence = '; '.join(f'{value} ({", ".join(sorted(agents))})' for value, agents in sorted(found.items()))
            fail(problems, f'{label} differs — {divergence}')

    found = {}
    for agent, path in ENGINE_ID_SOURCES.items():
        match = ENGINE_ID_RULE.search(path.read_text(encoding='utf-8'))
        if not match:
            fail(problems, f'{agent}: ENGINE_ID not found in {path.relative_to(ROOT)} — '
                           'nothing says what an engine document id may look like')
            continue
        found.setdefault(match.group(1), []).append(agent)
    if len(found) > 1:
        divergence = '; '.join(f'{", ".join(sorted(agents))}: {pattern}'
                               for pattern, agents in sorted(found.items()))
        fail(problems, f'the shape an engine document id may have differs — {divergence}')


# The vocabulary the engine holds. Six words, and the agents translate their own triggers into
# them: it is the engine that decides what it accepts, so this list moves on its side first.
WIRE_FLUSH_REASONS = {'idle', 'volume', 'save', 'focus', 'away', 'end'}

# `WIRE_FLUSH_REASONS` maps each agent's own triggers to that vocabulary — a JavaScript object,
# a Python dict, both read the same way.
FLUSH_TABLE = re.compile(r'WIRE_FLUSH_REASONS\s*=\s*\{(.*?)\n\}', re.DOTALL)
FLUSH_TRIGGER = re.compile(r"'?([a-z][a-z-]*)'?\s*:\s*'([a-z]+)'")

# Where each agent flushes, beyond its sensor: a trigger can be raised from the interface or
# from the host's own events, and it is the same table that has to know it.
FLUSH_SOURCES = {
    'navigateur': [ROOT / 'browser' / 'src' / 'content.js'],
    'word': [ROOT / 'word' / 'src' / 'sensor.js', ROOT / 'word' / 'src' / 'taskpane.js'],
    'vscode': [ROOT / 'vscode' / 'src' / 'sensor.js', ROOT / 'vscode' / 'src' / 'extension.js'],
    'libreoffice': [ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'sensor.py',
                    ROOT / 'libreoffice' / 'src' / 'pythonpath' / 'certimens_agent' / 'dialogs.py'],
}

# A flush whose trigger is decided elsewhere, not a literal to translate: `flush(reason)` passes
# on what it was given.
FLUSH_NOT_A_TRIGGER = {'reason'}

# A trigger is not always a literal handed to `flush()`: the extension counts the departure
# first and flushes from there, VS Code seals every open window at once, and the Python agent
# arms a timer with the name. All of them are the same thing — a word that will reach the table.
FLUSH_CALL = re.compile(r"\b(?:flush|flushAll|noteDeparture)\(\s*'([a-z][a-z-]*)'"
                        r"|self\.flush,\s*\(\s*'([a-z][a-z-]*)'")


def flush_table_of(path):
    """The trigger → wire-word table an agent declares, whatever its language."""
    found = FLUSH_TABLE.search(path.read_text(encoding='utf-8'))
    if not found:
        return None
    return dict(FLUSH_TRIGGER.findall(found.group(1)))


def flush_sources_of(paths):
    """An agent's sources, with its own translation table cut out of them."""
    texts = []
    for path in paths:
        text = path.read_text(encoding='utf-8')
        texts.append(FLUSH_TABLE.sub('', text))
    return texts


def flush_triggers_of(texts):
    """Every trigger an agent flushes on, read from its own call sites."""
    triggers = set()
    for text in texts:
        triggers |= {direct or indirect for direct, indirect in FLUSH_CALL.findall(text)}
    return triggers - FLUSH_NOT_A_TRIGGER


def check_flush_reasons(problems):
    """Why a window closed is declared four times, in one vocabulary.

    The engine cannot tell an agent's triggers apart on its own: a save cutting a burst in two
    reads as a writer who never stops, and a departure to a second window reads as a pause for
    thought. Each agent therefore translates its own triggers into the six shared words of
    `why` — and the word is mandatory, so a trigger it forgets to translate seals a window that
    has none and is refused. No test of a single agent would see it: the trigger is only missing
    from a table the test does not know should hold it.
    """
    documented = set()
    for cells in doc_tables(DOC.read_text(encoding='utf-8')).get("Pourquoi la fenêtre s'est fermée", []):
        documented |= set(re.findall(r'^`([a-z]+)`$', cells[0]))
    if documented != WIRE_FLUSH_REASONS:
        fail(problems, f'docs/mesures.md: the vocabulary of "Pourquoi la fenêtre s\'est fermée" is '
                       f'{sorted(documented)} and the engine takes {sorted(WIRE_FLUSH_REASONS)}')

    for agent, paths in FLUSH_SOURCES.items():
        table = flush_table_of(SENSORS[agent])
        if table is None:
            fail(problems, f'{agent}: WIRE_FLUSH_REASONS is missing from '
                           f'{SENSORS[agent].relative_to(ROOT)}')
            continue
        for trigger, word in sorted(table.items()):
            if word not in WIRE_FLUSH_REASONS:
                fail(problems, f'{agent}: translates "{trigger}" into "{word}", which is not one '
                               f'of the words the engine takes ({", ".join(sorted(WIRE_FLUSH_REASONS))})')
        texts = flush_sources_of(dict.fromkeys([SENSORS[agent], *paths]))
        for trigger in sorted(flush_triggers_of(texts) - set(table)):
            fail(problems, f'{agent}: flushes on "{trigger}" and its WIRE_FLUSH_REASONS does not '
                           f'translate it — the window would be sealed without a `why`, '
                           f'which the engine refuses')
        # The other way round is looser on purpose: a trigger can be raised through a timer or
        # a return value, which no regular expression reads reliably. What it does catch is a
        # word that has disappeared from the agent entirely.
        for trigger in sorted(set(table)):
            if not any(f"'{trigger}'" in text for text in texts):
                fail(problems, f'{agent}: translates "{trigger}", which appears nowhere else in '
                               f'its sources — the table describes triggers that exist')


def check_shared_files(problems):
    """What the four share lives in `browser/` and reaches them through a symlink.

    A copy would pass the linters and the tests, then diverge in silence. It is recognised by
    this: a file of an agent whose content is that of a file of `browser/` under the same name,
    without being a link. The VS Code dictionary, for its part, is an *accepted* copy (CommonJS):
    it does not say the same thing byte for byte, and its parity test holds it.
    """
    reference = {}
    for base in ((ROOT / 'browser' / 'src'), (ROOT / 'browser' / 'tests')):
        for path in base.rglob('*'):
            if path.is_file() and not path.is_symlink():
                reference.setdefault(path.name, []).append(path)

    for agent in ('word', 'vscode', 'libreoffice'):
        for path in (ROOT / agent).rglob('*'):
            if 'node_modules' in path.parts or 'dist' in path.parts or '.venv' in path.parts:
                continue
            if path.is_symlink():
                if not path.exists():
                    fail(problems, f'{agent}: {path.relative_to(ROOT)} is a broken link')
                continue
            if not path.is_file():
                continue
            for twin in reference.get(path.name, []):
                if path.read_bytes() == twin.read_bytes():
                    fail(problems, f'{agent}: {path.relative_to(ROOT)} is a copy of '
                                   f'{twin.relative_to(ROOT)} — what is shared arrives through a symlink')


def main():
    problems = []
    sections = doc_tables(DOC.read_text(encoding='utf-8'))
    documented_constants = parse_documented_constants(sections.get('Constantes communes', []), problems)
    documented_kinds = parse_documented_words(sections.get(RUNS_SECTION, []))
    documented_counts = parse_documented_words(sections.get(COUNTS_SECTION, []))
    if not documented_constants or not documented_kinds or not documented_counts:
        print(f'docs/mesures.md: tables "Constantes communes", "{RUNS_SECTION}" and '
              f'"{COUNTS_SECTION}" not found', file=sys.stderr)
        return 1

    check_constants(documented_constants, problems)
    check_run_kinds(documented_kinds, problems)
    check_counts(documented_counts, problems)
    check_unseen(problems)
    check_protocol_numbers(sections, problems)
    check_flush_reasons(problems)
    check_shared_urls(problems)
    check_engine_url_rule(problems)
    check_agent_declaration(problems)
    check_document_identity(problems)
    check_shared_files(problems)

    if problems:
        print(f'Four-agent coherence: {len(problems)} divergence(s).\n', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        print('\nA measurement rule is unique and its implementations are four: '
              'fix it everywhere, or document the gap.', file=sys.stderr)
        return 1

    print(f'Four-agent coherence: {len(documented_constants)} constants, {len(documented_kinds)} kinds '
          f'of run and {len(documented_counts)} counts, in agreement everywhere.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
