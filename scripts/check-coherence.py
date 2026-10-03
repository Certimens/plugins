#!/usr/bin/env python3
"""What binds the four agents together, checked mechanically.

Each agent has its linters and its tests, and none of them can see the three others: the
invariants that cross the repository — "one definition, four implementations" — were until now
held by review alone. Six of them are checkable, and are checked here:

1. **The shared constants** (`docs/mesures.md`, section *Constantes communes*) have the same
   value in all four sensors, units included: `IDLE_FLUSH_MS` equals `IDLE_FLUSH_S`. The
   documentation's table is the reference, and it is what the code is compared against: a value
   changed in one sensor and nowhere else shows up here.
2. **The metrics sent** by each agent are the ones that same page documents, and the only ones
   an agent does not send are the accepted gaps, named below. A metric added to three agents out
   of four, or forgotten in the table, shows up here.
3. **What the four share arrives through symlinks, never through a copy.** A link replaced by a
   copy passes every linter and every test, and the two files then diverge without a word.
4. **The default engine address** is the same in the four clients. Each agent is standalone and
   declares it at home; nothing, until now, would say that one of them sends elsewhere — and the
   divergence would only show on the agent of a student who no longer reaches anything.
5. **The generations of extended metrics** (`docs/moteur.md`, *Metrics refusées*) are the same
   four times, in the same order, and every metric younger than the first engines belongs to
   one. A metric added to the sensors and to no generation is the trap this check exists for:
   everything passes, until the first engine that does not know the new type refuses the whole
   window — including the measurements it does know how to read.
6. **The flush reasons sent** (`docs/mesures.md`, section *Pourquoi la fenêtre s'est fermée*):
   every trigger an agent can flush on is translated into the shared vocabulary, and nothing
   outside that vocabulary is ever sent. A trigger added to a sensor and forgotten in the table
   sends nothing: the engine then reads the window as coming from an agent that does not say
   why it flushes, falls back to guessing, and nothing anywhere says so.
7. **The shape of metric names** (`docs/mesures.md`, *Comment un nom de metric se forme*):
   `<subject>_<statistic>_<unit>`, the unit abbreviated, the statistic never first, a duration
   always in milliseconds. Left to themselves, names are made one at a time and the shape is
   lost; renaming a metric costs a piece of work on the engine side, and this check costs a
   second.
8. **The rule on where the token may travel** (`docs/moteur.md`, *L'adresse du moteur*): the
   pattern naming the hosts a plain `http:` engine address may use is the same in the four
   clients, character for character. It is the one rule that decides whether an API token that
   never expires crosses the network in the clear, it is written four times in two languages,
   and an agent loosened on its own would be a hole with nothing anywhere to say so.

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

# Where each agent declares the generations of extended metrics. It is the engine client for
# three of them; the extension declares them in its service worker, which is what pushes a
# window and what reads the refusal.
GENERATION_SOURCES = dict(ENGINE_CLIENTS, navigateur=ROOT / 'browser' / 'src' / 'background.js')

# The accepted gaps of `docs/mesures.md`: what an agent cannot see, and why. A metric missing
# from an agent without appearing here is a forgotten metric, not a gap.
EXPECTED_GAPS = {
    # Office delivers neither keystrokes nor the document losing focus: a rhythm computed on its
    # events would be wrong, and a return to the document is not signalled to it.
    # And a word search is a silence between two keystrokes: not seeing the keys, it cannot see
    # the silences between them either, nor what was typed on coming back from somewhere.
    'word': {'flight_mad_ms', 'flight_median_ms', 'focus_losses', 'injected_chars_after_return',
             'lexical_hesitations', 'keystrokes_after_return'},
    # An insertion made in one go is a paste, a snippet or an accepted completion there, and the
    # API does not say which: the paste *count* would be wrong, and so would the *count* of
    # restitutions. Their volume is not: the editor gives the document, and a text it already
    # held cannot have been imported by the gesture that put it there a second time, so
    # `self_paste_chars_total` is measured and sent.
    'vscode': {'paste_events', 'self_paste_events'},
    'navigateur': set(),
    'libreoffice': set(),
}

# The constants an agent does not declare, because the rule they bound does not exist there.
# These are the same accepted gaps as above, seen from the constants' side.
CONSTANT_GAPS = {
    # Word does not see keystrokes: it has no flight times to bound. Nor does it see the document
    # losing focus, hence no return to date a paste from either.
    'word': {'FLIGHT_MAX_MS', 'RETURN_WINDOW_MS', 'HESITATION_MIN_MS', 'HESITATION_MAX_MS'},
    # VS Code does not recognise a restitution: nothing to hash, to keep, or to compare.
    'vscode': {'SHINGLE_WORDS', 'SELF_PASTE_RATIO', 'SELF_PASTE_TTL_MS', 'SELF_PASTE_MAX_COPIES'},
    'navigateur': set(),
    'libreoffice': set(),
}

# The constants a single agent declares, for a reason that belongs to it alone.
LOCAL_CONSTANTS = {'SELECTION_ECHO_MS'}

# The metrics every deployed engine has always taken: what existed before the generations did.
# This set **cannot grow** — a metric added since is, by construction, in a generation — so a
# documented metric that is neither here nor in one is a metric nobody declared as recent. It
# would be sent to every engine, and the first one too old to know the type would refuse the
# whole window, including the measurements it reads perfectly well.
ALWAYS_KNOWN = {
    'real_volume_chars', 'effective_time_ms', 'keystrokes_total', 'injected_chars_total',
    'immediate_corrections', 'deferred_reformulations', 'navigation_jumps', 'macro_revisions',
    'cognitive_pauses', 'flight_mad_ms',
}


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

    `| PAUSE_MIN_S / PAUSE_MAX_S | 3 s / 300 s |` names two distinct constants on one row;
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


# A unit spelled out, where the rest of the set abbreviates it (`_ms`, `_s`, `_chars`).
SPELLED_OUT_UNITS = ('_seconds', '_second', '_milliseconds', '_millisecond', '_characters',
                     '_character', '_bytes', '_minutes', '_percent')

# A statistic is a qualifier: it follows the subject, it does not replace it. `mad_ms` did not
# say what it was the deviation of.
STATISTICS = ('total', 'max', 'min', 'median', 'mad', 'avg', 'mean', 'sum', 'count')


def check_metric_names(documented, problems):
    """The shape of a metric name, which no linter looks at and only habit was holding."""
    for name in documented:
        if name.endswith(SPELLED_OUT_UNITS):
            fail(problems, f'docs/mesures.md: "{name}" spells its unit out — '
                           f'the rest of the set abbreviates it (_ms, _chars)')
        if name.endswith('_s'):
            fail(problems, f'docs/mesures.md: "{name}" counts in seconds — a duration is '
                           f'measured in milliseconds, like the flight times, and is not '
                           f'rounded before being sent')
        if name.split('_')[0] in STATISTICS:
            fail(problems, f'docs/mesures.md: "{name}" starts with a statistic — '
                           f'the subject comes first (<subject>_<statistic>_<unit>)')


def parse_documented_metrics(rows):
    """The *Metrics envoyées* table: one type per row."""
    metrics = []
    for cells in rows:
        if not cells or not cells[0].startswith('`'):
            continue
        found = re.match(r'^`([a-z][a-z0-9_]*)`$', cells[0])
        if found:
            metrics.append(found.group(1))
    return metrics


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


def metrics_of(path):
    """The metric types a sensor puts into the window it sends.

    All four build the same `values` object, then add the conditional measurements (the rhythm,
    the volume) to it one by one: both forms are read.
    """
    text = path.read_text(encoding='utf-8')
    body = block_after(text, 'values = {')
    names = set(re.findall(r"^\s*'?([a-z][a-z0-9_]*)'?\s*:", body, re.MULTILINE))
    names |= set(re.findall(r"values\.([a-z][a-z0-9_]*)\s*=(?!=)", text))
    names |= set(re.findall(r"values\['([a-z][a-z0-9_]*)'\]\s*=", text))
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
                    ('FLUSH', 'IDLE', 'PAUSE', 'ACTIVE', 'INJECTION', 'FLIGHT', 'SHINGLE', 'SELF_PASTE', 'RETURN')):
                fail(problems, f'{agent}: {name} looks like a shared constant, '
                               f'but is not in the table of docs/mesures.md')


def check_metrics(documented, problems):
    known = set(documented)
    for agent, path in SENSORS.items():
        emitted = metrics_of(path)
        for name in sorted(emitted - known):
            fail(problems, f'{agent}: sends "{name}", which the table of docs/mesures.md does not document')
        missing = known - emitted - EXPECTED_GAPS[agent]
        for name in sorted(missing):
            fail(problems, f'{agent}: does not send "{name}", and that is not an accepted gap '
                           f'(docs/mesures.md, "Écarts assumés")')
        for name in sorted(EXPECTED_GAPS[agent] & emitted):
            fail(problems, f'{agent}: sends "{name}", which the accepted gaps say is absent — '
                           f'the gap is to be removed from docs/mesures.md and from this script')


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


# `EXTENDED_GENERATIONS` is declared in each agent's engine client, one generation per line and
# newest first — a JavaScript array of arrays, a Python list of tuples.
GENERATIONS_BLOCK = re.compile(r'EXTENDED_GENERATIONS\s*=\s*\[(.*?)\n\]', re.DOTALL)


def generations_of(path):
    """The generations of extended metrics an agent declares, newest first."""
    found = GENERATIONS_BLOCK.search(path.read_text(encoding='utf-8'))
    if not found:
        return None
    return [tuple(re.findall(r"'([a-z][a-z0-9_]*)'", line))
            for line in found.group(1).splitlines() if line.strip()]


def documented_generations(problems):
    """The *Metrics refusées* table of `docs/moteur.md`, oldest generation first."""
    sections = doc_tables(ENGINE_DOC.read_text(encoding='utf-8'))
    table = {}
    for cells in sections.get('Metrics refusées', []):
        if len(cells) < 2 or not cells[0].strip().isdigit():
            continue
        table[int(cells[0].strip())] = tuple(re.findall(r'`([a-z][a-z0-9_]*)`', cells[1]))
    if sorted(table) != list(range(1, len(table) + 1)):
        fail(problems, 'docs/moteur.md: the generations of "Metrics refusées" are not '
                       'numbered 1..n without a hole')
        return None
    return [table[number] for number in sorted(table)]


def check_generations(documented_metrics, problems):
    """A metric younger than the first engines is declared, four times, in the same generation.

    Refusing a type is all an engine too old says — not which type — so an agent drops a whole
    generation at a time. That only works if the generations are the same everywhere: an agent
    that forgot one sends a type nobody declared as recent, is refused, and drops generations
    that engine could read, one after another, until it has nothing recent left to drop. The
    measurements lost that way are indistinguishable, on the engine's side, from measurements
    the sensor cannot take — which is why no test anywhere would see it.
    """
    documented = documented_generations(problems)
    declared = {}
    for agent, path in GENERATION_SOURCES.items():
        found = generations_of(path)
        if found is None:
            fail(problems, f'{agent}: EXTENDED_GENERATIONS not found in {path.relative_to(ROOT)}')
            continue
        declared[agent] = found

    for agent, found in declared.items():
        if documented is not None and found != list(reversed(documented)):
            fail(problems, f'{agent}: its generations are not those of docs/moteur.md '
                           f'("Metrics refusées"), newest first: {found}')
        for generation in found:
            for name in generation:
                if name not in documented_metrics:
                    fail(problems, f'{agent}: declares "{name}" in a generation, and the table '
                                   f'of docs/mesures.md does not document it')

    if documented is None:
        return
    seen = {}
    for number, generation in enumerate(documented, start=1):
        for name in generation:
            if name in seen:
                fail(problems, f'docs/moteur.md: "{name}" is in generations {seen[name]} and '
                               f'{number} — a metric belongs to exactly one')
            seen[name] = number
    for name in sorted(set(documented_metrics) - ALWAYS_KNOWN - set(seen)):
        fail(problems, f'"{name}" is in no generation and is not one of the metrics every '
                       f'engine has always taken: add it to a new generation in '
                       f'docs/moteur.md and in the four engine clients')


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
    thought. Each agent therefore translates its own triggers into the six shared words — and a
    trigger it forgets to translate sends nothing at all, which the engine reads as an agent
    that does not say. That is the safe failure, and it is silent: no test of a single agent
    would see it, because sending nothing is exactly what an older agent does.
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
                           f'translate it — the window would leave saying nothing, which the '
                           f'engine reads as an agent that cannot say why it flushes')
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
    documented_metrics = parse_documented_metrics(sections.get('Metrics envoyées', []))
    if not documented_constants or not documented_metrics:
        print('docs/mesures.md: tables "Constantes communes" and "Metrics envoyées" not found', file=sys.stderr)
        return 1

    check_constants(documented_constants, problems)
    check_metric_names(documented_metrics, problems)
    check_metrics(documented_metrics, problems)
    check_generations(documented_metrics, problems)
    check_flush_reasons(problems)
    check_shared_urls(problems)
    check_engine_url_rule(problems)
    check_shared_files(problems)

    if problems:
        print(f'Four-agent coherence: {len(problems)} divergence(s).\n', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        print('\nA measurement rule is unique and its implementations are four: '
              'fix it everywhere, or document the gap.', file=sys.stderr)
        return 1

    print(f'Four-agent coherence: {len(documented_constants)} constants and '
          f'{len(documented_metrics)} metrics, in agreement everywhere.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
