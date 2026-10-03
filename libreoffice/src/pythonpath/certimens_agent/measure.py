"""Writing measurement windows: the logic of browser/content.js, without LibreOffice.

Receives already-translated events (key, click, paste, leaving the document) and builds the
window the engine is sent: the gestures in the order they happened, as runs; what only this
sensor can classify, as a few counts; the rhythm, as histograms; where the text changed, as
lengths. No key is retained: only its category (erase, navigation, shortcut) and the time of
the keystroke. sensor.py wires this logic to LibreOffice's events; tests/test_measure.py checks
it without LibreOffice.

Nothing the engine can work out from the runs is counted here to be sent: how many keystrokes,
pastes, injected characters, hesitations or pauses a window holds is read by the engine, in one
place, from what the window says happened.
"""

import re
import secrets
import time
import unicodedata
from bisect import bisect_right
from collections import Counter
from difflib import SequenceMatcher

FLUSH_KEYSTROKES = 200      # flush at 200 keystrokes, like the desktop agents
IDLE_FLUSH_S = 2.0          # flush after 2 s with no activity
# What the engine is told about *why* a window was sealed, for each of the triggers that can
# seal one. The engine cannot tell them apart on its own: a save cutting a burst in two looked,
# on its side, like a writer who never stops, and leaving the document looked like a pause for
# thought. Only 'away' and 'end' mean nobody was looking at the document.
#
# The wire vocabulary is six words and it is the same for the four agents (docs/mesures.md); the
# triggers on the left are this extension's own. A window cannot be sealed without one of them
# — the word is mandatory — so a trigger missing from the table is refused where the window is
# sealed, and `make check` is what keeps one from going missing.
WIRE_FLUSH_REASONS = {
    'idle': 'idle',         # 2 s without activity: the writer stopped
    'volume': 'volume',     # FLUSH_KEYSTROKES reached: the counter stopped, not the writer
    'save': 'save',         # Ctrl/Cmd+S in the middle of a burst
    'blur': 'away',         # the document window was deactivated (departure counted)
    'pause': 'end',         # measuring suspended
    'logout': 'end',        # the student signed out: the session that measured it is over
    'pagehide': 'end',      # the document is closing
}
FLIGHT_MAX_MS = 800         # beyond this, the gap between two keystrokes is not a "flight time"
ACTIVE_GAP_MAX_S = 60       # beyond this a gap adds nothing to the effective time
# A shorter paste is not an injection. The engine applies the same rule to the paste runs it
# receives; it is held here too for one number only, the running total of injected characters
# every window carries (`sum.chars`), which is what shows a window that never arrived.
INJECTION_MIN_CHARS = 15
# How many characters taken out in one unbroken run stop being a typo and start being a phrase the
# writer decided against. A mis-hit letter costs one to a few erases; past this many it is a word
# or a clause coming out, which is a reformulation whatever key did it.
ERASE_RUN_REFORMULATES = 6
# How many moves before writing again count as having gone somewhere. One is a brush against an
# arrow, or a caret nudged by a character; two or more is a trip back into the text.
NAV_STEPS_AWAY = 2
MAX_FLIGHTS = 500
# A text the student sends to a corrector (Scribens, Antidote, a translator) and pastes back is
# not an injection: it is their own writing, revised. What leaves the document is remembered as
# hashed word shingles — never as text — and a paste that overlaps them enough is counted as the
# massive revision it is. A corrector changes a few words in a hundred, so four-word shingles
# survive it in large majority; 70 % leaves room for a rewritten sentence or two.
SHINGLE_WORDS = 4           # a shingle is four consecutive words
SELF_PASTE_RATIO = 0.7      # overlap above which a paste is the student's own text
SELF_PASTE_TTL_S = 3600     # how long what left the document stays comparable
SELF_PASTE_MAX_COPIES = 20  # only the last copies are kept: the memory is bounded
# How long after coming back to the document a paste still counts as "brought back from
# elsewhere". Leaving, consulting something, coming back and pasting is one gesture; fifteen
# seconds is long enough to find the paragraph again and short enough not to catch a paste made
# in the middle of a writing session that happens to follow a departure.
RETURN_WINDOW_S = 15
# From this long on, a silence between two counted keystrokes is said in the timeline, at its
# real length. What it means — a word being looked for, a pause for thought, a departure — is
# read by the engine from that length: this sensor holds no such band.
GAP_MIN_MS = 1000


# --- What a window is made of ---
#
# None of it is a character, a key or a fingerprint of the text: the timeline is made of *runs*
# ("20 keystrokes in 4.2 s"), never one record per key, and a run never breaks on a class of
# character — neither a space nor a punctuation mark — so the length of a word cannot be read
# in it. The rhythm leaves as histograms: how many gaps in each band, never their order.
TIMELINE_MAX_RUNS = 512     # what the engine accepts in one window
# A window is sealed this many runs before the ceiling, whatever it holds: one event adds at
# most three (the silence it ends, the keystroke, the undo it was), and the timeline is the
# window — there is no sending one with a run left out.
TIMELINE_HEADROOM = 8
# Lower edges, in milliseconds. The last flight band stops at FLIGHT_MAX_MS, where a gap stops
# being a flight time; the last dwell band is open.
FLIGHT_BINS_MS = (0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650)
DWELL_BINS_MS = (0, 20, 40, 60, 80, 100, 120, 150, 200, 300)
# A session is named by this many random bytes, URL-safe: 128 bits, 22 characters. Drawn when
# the sensor starts measuring a document, kept in memory, derived from nothing.
SESSION_ID_BYTES = 16
# Beyond this many words on either side of a span, what it kept is not computed (see text_kept).
TEXT_KEPT_MAX_WORDS = 2000
# And beyond this many pairs of equal words between the two sides, which is what the comparison
# costs: ordinary prose reaches it around a thousand words a side, a text made of one repeated
# word after a hundred and sixty. Measured at 5 to 10 ms on a development machine at this
# bound — and at 600 ms without it, on the student's thread, for two thousand identical words.
TEXT_KEPT_MAX_PAIRS = 25000
# A word with the blanks that follow it, or leading blanks: the pieces a text is cut into to be
# compared word by word. They cover the text exactly, so a passage left untouched is kept whole.
WORD_PIECE = re.compile(r'\S+\s*|\s+')

# The kinds of run, and the three shapes a run has. The first four are the keystrokes — the
# engine adds them up to the keystrokes of the window — and are written [kind, n, ms]: `n`
# keystrokes from the first to the last. The others are gestures that do not last, written
# [kind, n]; a click least of all: it often falls inside a silence, which already covers that
# time. A silence is ['gap', ms]. `fix` and `move` exist on the wire and not here: this sensor
# sees no spelling correction being accepted, and every move it sees is a key or a click.
RUN_TYPE = 'type'               # keystrokes that write
RUN_ERASE = 'erase'             # Backspace, Delete, and their by-word variants
RUN_NAV = 'nav'                 # moves made from the keyboard
RUN_OTHER = 'other'             # any other counted keystroke: a shortcut, a block pasted back
RUN_CLICK = 'click'             # clicks in the document
RUN_GAP = 'gap'                 # a silence of at least GAP_MIN_MS between two keystrokes
RUN_PASTE = 'paste'             # a paste from elsewhere, one run per gesture; n is characters
RUN_SELF = 'self'               # the student's own text coming back; n is characters
RUN_COPY = 'copy'               # text taken out of the document; n is characters
RUN_UNDO = 'undo'               # undos
TIMED_RUNS = {RUN_TYPE, RUN_ERASE, RUN_NAV, RUN_OTHER}
# The runs that are never merged with the one before: each silence and each paste is its own.
SINGLE_RUNS = {RUN_GAP, RUN_PASTE, RUN_SELF}

NOT_A_WORD = re.compile(r'[\W_]+', re.UNICODE)

# Key categories (sensor.py translates the com.sun.star.awt.Key codes).
ERASE = 'erase'             # Backspace, Delete
NAVIGATION = 'navigation'   # arrows, Home/End, Page Up/Down
MODIFIER = 'modifier'       # a modifier key alone
PASTE = 'paste'             # Ctrl/Cmd+V, Shift+Insert: what the key posts is counted in on_paste
OTHER = 'other'


def median(values):
    if not values:
        return 0
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def median_absolute_deviation(values):
    """Median absolute deviation (MAD) of the flight times: regularity of the typing rhythm."""
    if len(values) < 2:
        return 0
    med = median(values)
    return median([abs(v - med) for v in values])


def normalize_words(text):
    """Normalisation absorbs exactly what a corrector changes: case, accents, punctuation and
    spacing. What is left is the sequence of words, which a correction leaves nearly intact."""
    stripped = ''.join(c for c in unicodedata.normalize('NFD', text) if not unicodedata.combining(c))
    return NOT_A_WORD.sub(' ', stripped.lower()).split()


def hash_shingle(words):
    """FNV-1a over the words of a shingle: what is kept is a number, from which the words cannot
    be read back. The same function, on the same text, gives the same number in the four agents
    (browser/src/content.js holds the JavaScript twin)."""
    value = 0x811c9dc5
    for char in ' '.join(words):
        value ^= ord(char)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value


def shingles(text):
    words = normalize_words(text)
    if not words:
        return set()
    # Shorter than a shingle -- a couple of words moved from one sentence to another -- is hashed
    # whole rather than dropped. Without it, moving "developpement durable" inside the document
    # was an injection: nothing had been remembered when it left, so nothing could recognise it
    # coming back. One fingerprint over the whole sequence can only ever match a paste just as
    # short, so it still cannot excuse a text taken from somewhere else.
    if len(words) < SHINGLE_WORDS:
        return {hash_shingle(words)}
    return {hash_shingle(words[i:i + SHINGLE_WORDS])
            for i in range(len(words) - SHINGLE_WORDS + 1)}


def histogram(values, edges):
    """How many values fall in each band, the bands being given by their lower edges. The order
    of the values is lost, which is the point: a rhythm leaves as a distribution."""
    counts = [0] * len(edges)
    for value in values:
        counts[max(0, bisect_right(edges, value) - 1)] += 1
    return counts


def trimmed(counts):
    """A histogram as it is sent: without its trailing zeros, which the engine puts back. A
    window that timed nothing sends []."""
    end = len(counts)
    while end and not counts[end - 1]:
        end -= 1
    return counts[:end]


def _common_prefix(a, b, limit):
    """Length of the common prefix of a and b, within their first `limit` characters. Compared
    by halves rather than character by character: slices are compared natively, and a document
    is a few hundred thousand characters read on the student's own thread."""
    low, high = 0, limit
    while low < high:
        mid = (low + high + 1) // 2
        if a[low:mid] == b[low:mid]:
            low = mid
        else:
            high = mid - 1
    return low


def _common_suffix(a, b, limit):
    """Length of the common suffix of a and b, within their last `limit` characters."""
    low, high = 0, limit
    while low < high:
        mid = (low + high + 1) // 2
        if a[len(a) - mid:len(a) - low] == b[len(b) - mid:len(b) - low]:
            low = mid
        else:
            high = mid - 1
    return low


def text_span(before, after):
    """Where two readings of the text differ: (at, cut, add), in characters.

    `at` is their longest common prefix, and what follows it is cut by their longest common
    suffix, the two never overlapping. Three lengths, computed here: neither reading leaves the
    machine, and nothing of what they hold can be read back from where and how much.
    """
    shortest = min(len(before), len(after))
    at = _common_prefix(before, after, shortest)
    tail = _common_suffix(before, after, shortest - at)
    return at, len(before) - at - tail, len(after) - at - tail


def text_kept(removed, inserted):
    """Among what a span inserted, how many characters were already in what it removed, in the
    same order — or None when that is not computed.

    A span is a hull: two places touched between two readings give one span from the first to
    the last, and everything left intact between them sits in both `removed` and `inserted`.
    This is what tells it from new text. The two middles are compared word by word, a word
    going with the blanks after it, and what is returned is one more length.

    Bounded, because it runs on the student's machine when a window is sealed: past
    TEXT_KEPT_MAX_WORDS words on either side, or TEXT_KEPT_MAX_PAIRS pairs of equal words
    between the two, nothing is computed and the span goes without it. The matching blocks of
    difflib are a common subsequence, not always the longest: what they miss is counted as new
    text, never the other way round, so `kept` can only be understated.
    """
    if not removed or not inserted:
        return 0
    before = WORD_PIECE.findall(removed)
    after = WORD_PIECE.findall(inserted)
    if len(before) > TEXT_KEPT_MAX_WORDS or len(after) > TEXT_KEPT_MAX_WORDS:
        return None
    seen = Counter(after)
    if sum(count * seen[piece] for piece, count in Counter(before).items()) > TEXT_KEPT_MAX_PAIRS:
        return None
    blocks = SequenceMatcher(None, before, after, autojunk=False).get_matching_blocks()
    return sum(len(piece) for start, _, size in blocks for piece in before[start:start + size])


class _Copy:
    """What left the document, hashed: its shingles, the last time it was seen — when it left,
    then each time it came back — and whether it has already come back once. A block the student
    keeps pasting back stays comparable as long as they keep using it."""

    __slots__ = ('marks', 'restituted', 'seen_at')

    def __init__(self, marks, seen_at):
        self.marks = marks
        self.seen_at = seen_at
        self.restituted = False


class Window:
    """One measurement window, while it is open."""

    def __init__(self):
        # The wall clock at the first activity: the one instant of the window read on it.
        self.at = None
        self.active_ms = 0
        # What only this sensor can classify, and so what is sent as counts.
        self.corrections = 0
        self.reformulations = 0
        self.macro_revisions = 0
        self.navigation = 0
        self.focus_losses = 0
        self.keystrokes_after_return = 0
        self.injected_chars_after_return = 0
        # What the engine reads from the runs. Kept here for two things only: knowing whether
        # the window holds anything to send, and the running totals of the session.
        self.keystrokes = 0
        self.paste_events = 0
        self.injected_chars = 0
        self.flights = []
        # The first and the last activity, on the monotonic clock.
        self.mono_start = None
        self.mono_last = None
        # The runs, in the shape of their kind, in the order the gestures happened.
        self.timeline = []
        # When the last run began; None when it was opened by a gesture that does not last.
        self.run_from = None
        # Where the next silence goes: right after the last key that was pressed and counted,
        # which is where it began — and at the head of the timeline until there has been one.
        self.quiet_from = 0
        self.dwells = [0] * len(DWELL_BINS_MS)
        self.rollover = 0


class Measure:
    """Measurement of a document.

    Every instant the on_* methods are given is in seconds **on the monotonic clock**
    (time.monotonic()): each duration that leaves — what a window lasted, its effective time,
    a run, a silence, a flight time — is a difference of two of them, so none can be bent by
    the clock of the machine being set forward or back. The wall clock is read here for one
    thing, the date of a window's first activity (`at`).

    The on_* methods return the reason for an immediate flush ('save', 'volume') or None;
    the caller handles the idle delay (IDLE_FLUSH_S after last_activity()).
    """

    def __init__(self, monotonic=time.monotonic, wall=time.time):
        self.window = Window()
        # The clock the callers read their instants on, read here when a session is opened
        # with no event to date it; and the wall clock `at` is read on. The first only ever
        # goes forward, which the second does not promise: a window says both, and the two
        # together are what shows an hour set back.
        self.monotonic = monotonic
        self.wall = wall
        # The session: the stretch during which this sensor measures this document. Its windows
        # are numbered and its totals kept here, at sealing, so that a window that never arrives
        # is missed by the next one. Nothing of it is written anywhere but in a queued window.
        self.session = None
        self.session_zero = 0
        self.seq = 0
        self.totals = {}
        # The previous reading of the text and the window that carried it, for the span of the
        # next one. In memory only, and let go with the session.
        self.previous_text = None
        self.previous_text_seq = None
        # Which window is open, as a number the sensor can hold on to: a key released after its
        # window was sealed is not timed. last_typed is that number when the last key was
        # counted as RUN_TYPE, None otherwise.
        self.opened = 1
        self.last_typed = None
        self.last_press = 0
        self.last_event = 0
        self.last_activity = 0
        # How far the writer has travelled since they last wrote anything. It replaces a boolean:
        # an erase only needs to know the caret moved at all, but an *insertion* has to tell a
        # real trip back through the text from a single arrow press, and a boolean cannot. See
        # NAV_STEPS_AWAY.
        self.nav_steps = 0
        # Erases pressed in an unbroken run, and whether that run has already been read as a
        # reformulation. Anything that is not an erase ends the run. See ERASE_RUN_REFORMULATES.
        self.erase_run = 0
        self.erase_run_reformulated = False
        # Scope of the selection the next keystroke would replace: 'all' for a Ctrl+A, 'range'
        # for a Shift+navigation selection, None for none. Typing or pasting over a selection
        # deletes it — a revision the sensor used to miss, watching only the erase keys.
        # (browser/content.js does the same; it can also see a mouse-dragged selection, which
        # LibreOffice's click handler does not report.)
        self.selection_scope = None
        # What left the document for a corrector, hashed: a list of _Copy.
        self.own_text = []
        # The document was left (a counted focus loss), then came back: the instant of the
        # return is what tells a paste brought back from elsewhere from one made while writing.
        self.away = False
        self.last_return = 0

    # --- session ---
    def start_session(self, now=None):
        """The sensor starts measuring this document: it was opened, or measuring resumes after
        a suspension or a new pairing. The name is random and derived from nothing — neither
        the account nor the machine — and `mono` is counted from here: from `now` when it is
        an event that opens the session, from the clock otherwise."""
        self.session = secrets.token_urlsafe(SESSION_ID_BYTES)
        self.session_zero = self.monotonic() if now is None else now
        self.seq = 0
        self.totals = {'keys': 0, 'chars': 0, 'pastes': 0}
        self.previous_text = None
        self.previous_text_seq = None
        # A silence never crosses a session: it is measured from the last keystroke counted in
        # this one, so the first window of a session opens on no silence — not on however long
        # the suspension before it lasted.
        self.last_event = 0

    def end_session(self):
        """Measuring stops: the document closes, or the student suspends or signs out. The
        previous reading of the text is let go here, not at the next start."""
        self.session = None
        self.previous_text = None
        self.previous_text_seq = None

    # --- timeline ---
    def _run(self, kind, now, n=1, timed=True):
        """One more gesture in the timeline: it extends the run in progress when it is of the
        same kind, and opens one otherwise. A run is never cut on what was typed.

        timed=False for a gesture that counts in a run without lasting in it: its instant is
        not one a silence is measured from, so it must not stretch the run either.
        """
        w = self.window
        last = w.timeline[-1] if w.timeline else None
        if last is not None and last[0] == kind and kind not in SINGLE_RUNS:
            last[1] += n
            if timed and kind in TIMED_RUNS:
                if w.run_from is None:
                    w.run_from = now
                # Rounded down: the runs of a window must not add up to more than it lasted.
                last[2] = max(0, int((now - w.run_from) * 1000))
            return
        # No ceiling is applied here: every handler that adds a run asks _crowded afterwards,
        # and the window is sealed well before the engine's limit with every run in it.
        w.timeline.append([kind, n, 0] if kind in TIMED_RUNS else [kind, n])
        w.run_from = now if timed else None

    def _gap(self, ms):
        """A silence between two keystrokes, put where it began: right after the last key
        pressed, before whatever was clicked or pasted while it lasted. The one that led up to
        the first keystroke of the window began before the window did, and so leads its
        timeline, wherever the clicks and pastes that opened the window fell — it is the one
        silence that is not part of what the window lasted."""
        w = self.window
        w.timeline.insert(w.quiet_from, [RUN_GAP, ms])
        w.quiet_from += 1

    def _keystroke(self, kind, now, pressed=True):
        """The one place a keystroke is counted, and so the one place a keystroke enters the
        timeline: the session's running total of keystrokes is what the engine adds up from
        the runs because both are fed here and nowhere else. pressed=False for the keystroke a
        block pasted back is worth: no key went down, so no silence starts or ends on it."""
        w = self.window
        w.keystrokes += 1
        self._run(kind, now, timed=pressed)
        if pressed:
            w.quiet_from = len(w.timeline)

    def _crowded(self):
        """Whether the timeline is about to reach what the engine accepts in one window. It is
        asked after every gesture that adds a run, and a crowded window is sealed whatever it
        holds — clicks and copies alone, if it comes to that: a window is sent with its whole
        timeline or not at all."""
        return len(self.window.timeline) >= TIMELINE_MAX_RUNS - TIMELINE_HEADROOM

    def on_release(self, opened, dwell_ms, rolled):
        """A key counted as RUN_TYPE was released: how long it was held, and whether it went
        down while another one was still down. `opened` is the window its press was counted in
        (last_typed, read right after on_key); a release that comes after that window was sealed
        is dropped, so a window never holds more dwell times than keys it typed — nor more
        rollovers than dwell times, the rollover being counted here and not at the press."""
        if opened != self.opened:
            return
        w = self.window
        w.dwells[max(0, bisect_right(DWELL_BINS_MS, dwell_ms) - 1)] += 1
        if rolled:
            w.rollover += 1

    # --- restitution of one's own text ---
    def on_copy(self, now, text):
        """Copy or cut: what leaves the document is remembered, hashed, so that it can be
        recognised if it comes back. Not an activity of its own — the Ctrl+C is already counted
        as a keystroke, and a copy opens no measurement window. Returns 'volume' when the
        window has to be sealed for its timeline, None otherwise."""
        if not text:
            return None
        # How much left, counted as a paste counts what arrives. Consecutive copies are one run.
        self._run(RUN_COPY, now, len(text.replace('\r', '').replace('\n', '')))
        marks = shingles(text)
        if marks:    # nothing but punctuation leaves no words to recognise later
            self.own_text.append(_Copy(frozenset(marks), now))
            if len(self.own_text) > SELF_PASTE_MAX_COPIES:
                # The memory is bounded, and what goes is the copy nothing has come back to for
                # the longest — not the oldest one. Copying five other things in between would
                # otherwise make the block the student is still pasting unrecognisable.
                self.own_text.remove(min(self.own_text, key=lambda copy: copy.seen_at))
        if not self._crowded():
            return None
        # The one case where a copy dates a window: the one it is about to seal needs an
        # instant, and clicks alone leave none behind once an idle delay has passed over them.
        self._mark(now)
        return 'volume'

    def _restitution(self, now, text):
        """Is this paste the student's own text coming back? Containment rather than a symmetric
        similarity: they may paste back one corrected paragraph out of the three they copied.
        Returns (is it theirs, is it coming back again) — again from the second return of the
        same copy, which is a duplication and not a revision."""
        self.own_text = [copy for copy in self.own_text if now - copy.seen_at < SELF_PASTE_TTL_S]
        marks = shingles(text)
        if not marks:
            return False, False
        seen = 0
        sources = []
        for mark in marks:
            copy = next((kept for kept in self.own_text if mark in kept.marks), None)
            if copy is None:
                continue
            seen += 1
            if copy not in sources:
                sources.append(copy)
        if seen / len(marks) < SELF_PASTE_RATIO:
            return False, False
        again = all(copy.restituted for copy in sources)
        for copy in sources:
            copy.seen_at = now
            copy.restituted = True
        return True, again

    # --- activity ---
    def _mark(self, now):
        if self.session is None:
            self.start_session(now)
        if self.window.mono_start is None:
            self.window.at = self.wall()
            self.window.mono_start = now
        self.window.mono_last = now

    def _silence(self, now):
        """**Typing** resumes: the silence since the last counted keystroke is said in the
        timeline when it lasted GAP_MIN_MS or more, at its real length and however long.

        Typing, and nothing else: on_key calls this where it counts a keystroke, so last_event
        is the last counted keystroke. A click, a paste and the PASTE key end no silence and
        start none: stopping two seconds, pressing Ctrl+V and typing again is one silence of
        the whole length, said once, when the next keystroke is counted (browser/content.js
        does the same). The flight times are not touched: they stay read from the last key
        pressed.

        The silence is not classified here. Whether it was a word being looked for, a pause
        for thought or a departure is the engine's reading of its length.
        """
        if self.last_event > 0:
            # To the nearest millisecond: the instants are floating-point seconds, and a
            # silence of exactly one second must not be lost to a 999.9999.
            gap = round((now - self.last_event) * 1000)
            if gap >= GAP_MIN_MS:
                self._gap(gap)
        self.last_event = now

    def _active_time(self, now):
        """Effective time: the real gap if <= 2 s, a flat 250 ms if < ACTIVE_GAP_MAX_S, nothing beyond."""
        if self.last_activity > 0:
            gap_ms = (now - self.last_activity) * 1000
            if gap_ms <= 2000:
                self.window.active_ms += gap_ms
            elif gap_ms < ACTIVE_GAP_MAX_S * 1000:
                self.window.active_ms += 250
        self.last_activity = now

    def has_activity(self):
        """Whether the window holds what makes it worth sealing: a keystroke or a paste. A
        restitution is one, by the keystroke it is worth."""
        return self.window.keystrokes > 0 or self.window.paste_events > 0

    def _end_erase_run(self):
        """Anything that is not an erase ends the run, so the next one is judged on its own
        length."""
        self.erase_run = 0
        self.erase_run_reformulated = False

    def _extend_erase_run(self):
        """One more character out of the run. True the one time the run crosses
        ERASE_RUN_REFORMULATES: that press is read as a reformulation, and the ones after it as
        nothing -- hammering Backspace through a phrase is **one** gesture."""
        self.erase_run += 1
        if self.erase_run < ERASE_RUN_REFORMULATES or self.erase_run_reformulated:
            return False
        self.erase_run_reformulated = True
        return True

    def on_held_erase(self):
        """Backspace or Delete repeating under a held key. A repeat is not a keystroke -- a held
        key is one deletion, whatever the repeat rate -- but what it takes out is a run like any
        other, and only its length can say whether a phrase went out with it. Nothing else is
        touched: no keystroke, no rhythm, no activity (browser/content.js does the same)."""
        if self._extend_erase_run():
            self.window.reformulations += 1

    def _consume_selection(self):
        """Spend a pending selection as the deletion it is: a whole-document one weighs as a mass
        revision, a Shift+navigation one as a deferred reformulation — the scale the erase keys
        already use. Returns True when one was spent."""
        if not self.selection_scope:
            return False
        if self.selection_scope == 'all':
            self.window.macro_revisions += 1
        else:
            self.window.reformulations += 1
        self.selection_scope = None
        return True

    # --- events ---
    def on_key(self, now, category, ctrl=False, letter=None, shift=False, jump=False, altgr=False):
        """Key pressed (excluding auto-repeat). letter: 's', 'x', 'z'… with Ctrl/Cmd. jump: a
        NAVIGATION key that crosses a word, a line or a page in one press, rather than an arrow.
        altgr: Ctrl and Alt held together, which is how Windows spells AltGr — the key writes a
        character, and the timeline must not tell it from any other.

        A PASTE key opens a window, dates what follows and feeds the rhythm like any other, but
        does not count a keystroke of its own — nor, for that reason, end a silence: see the
        end of this method.
        """
        # A modifier pressed on its own is not a keystroke: it writes nothing, and the near-zero
        # gap it leaves before the character it modifies would pass for an impossibly fast one.
        # browser/content.js drops it the same way; Word and VS Code, counting characters,
        # never see one. Dropped before anything else, so a Shift pressed between a click and a
        # Backspace no longer spends the click either.
        self.last_typed = None
        if category == MODIFIER:
            return None
        w = self.window
        self._mark(now)
        if self.last_press > 0:
            flight = (now - self.last_press) * 1000
            if flight < FLIGHT_MAX_MS:
                w.flights.append(flight)
                if len(w.flights) > MAX_FLIGHTS:
                    w.flights.pop(0)
        self.last_press = now

        # Ctrl+A selects the whole document; Shift with a navigation key extends a selection.
        # Shift alone must not count: it is also how capitals are typed.
        if ctrl and letter == 'a':
            self.selection_scope = 'all'
        elif shift and category == NAVIGATION:
            self.selection_scope = 'range'

        if category == ERASE:
            # Erasing a selection is scored by what it spans, not by what preceded it -- and it
            # ends the run, like everything else that is not one more press into it.
            #
            # That last part is a guard and not a repair: every way of making a selection already
            # passes through a handler that ends the run (Shift+arrow through the navigation
            # branch, Ctrl+A and a click through theirs), so the state cannot currently survive
            # into here. It is written down anyway because the invariant was holding in three
            # distant places at once, and the next way of setting a selection would have reopened
            # it in silence -- a run already credited leaves erase_run_reformulated set, and the
            # presses after it fall through both branches below and are counted nowhere at all.
            if not self._consume_selection():
                # Ctrl/Cmd+Backspace takes a whole word out in one press -- Writer binds it to
                # that key alone, on every platform. Whoever reaches for it is not repairing a
                # mis-hit letter: they are removing a word they have decided against, which is
                # the same act as walking back to it and erasing it.
                if ctrl or self.nav_steps > 0:
                    w.reformulations += 1
                    # The trip is spent on this one erase, and so is the run: what follows is
                    # being erased on the spot and reads as an immediate correction again. That
                    # rule predates the widening and stays deliberate — without it one click
                    # turned every later erase into a reformulation, and immediate corrections
                    # stayed at zero for a student who clicks before correcting, which is what
                    # everyone does (browser/content.js does the same).
                    self._end_erase_run()
                elif self._extend_erase_run():
                    # The run has gone past what a typo costs. It is read once and the rest of it
                    # is not counted again: it used to arrive as twenty immediate corrections.
                    w.reformulations += 1
                elif not self.erase_run_reformulated:
                    w.corrections += 1
            else:
                self._end_erase_run()
            self.nav_steps = 0
        elif category == NAVIGATION:
            w.navigation += 1
            # An arrow is a nudge by one character or one line. Home, End, a page, or an arrow
            # with Ctrl/Cmd/Option crosses a word or a line in one press: that is a jump, the one
            # an editor gives a shortcut for (sensor.py tells them apart).
            self.nav_steps += NAV_STEPS_AWAY if jump else 1
            self._end_erase_run()
            # A navigation without Shift collapses the selection instead of extending it.
            if not shift:
                self.selection_scope = None
        else:
            # A character typed over a selection replaces it. Ctrl shortcuts act on the selection
            # (copy, select-all) rather than replacing it, so they are excluded.
            replaced = not ctrl and self._consume_selection()
            # Writing again after travelling back through the text is a reformulation even when
            # nothing was erased first: inserting the word that was missing, or typing the new
            # wording in front of the old one. This branch used to drop the trip in silence,
            # which is why going back with the arrows and typing produced navigation jumps and no
            # reformulation at all.
            #
            # A selection just spent is **not** charged twice. Shift+arrows both extend a
            # selection and move the caret, so without this the one act of typing over a selected
            # span would be scored as the span *and* as the trip that selected it.
            if not ctrl and not replaced and self.nav_steps >= NAV_STEPS_AWAY:
                w.reformulations += 1
            self.nav_steps = 0
            self._end_erase_run()

        # Cutting or undoing settles the pending selection itself: the cut is the very deletion
        # the selection was waiting for, and an undo collapses it. Left pending, it would be
        # spent a second time by the next character typed or pasted — one action, two revisions.
        #
        # **Redo is not an undo**, and Shift is what tells them apart: Ctrl/Cmd+Shift+Z puts back
        # what the student had taken out, which is the opposite of a correction. The selection
        # collapses either way, so that part is settled before the test
        # (browser/content.js does the same).
        if ctrl and letter == 'x':
            w.macro_revisions += 1
            self.selection_scope = None
        undone = False
        if ctrl and letter == 'z':
            self.selection_scope = None
            if not shift:
                w.corrections += 1
                undone = True

        self._active_time(now)
        # A paste does write — but what it writes is weighed in on_paste, one keystroke for the
        # student's own text coming back and none for an injection, and weighed there whatever
        # pasted it: the menu and the toolbar have no key to count. Counting the key as well made
        # the same gesture cost two keystrokes from the keyboard and one from the menu
        # (browser/content.js drops it the same way). Ctrl/Cmd+C stays an ordinary keystroke: it
        # puts nothing into the document, so nothing else counts it.
        if category != PASTE:
            self._silence(now)
            # The kind of the run is the category the key arrived with, and nothing finer: a
            # key that is neither an erase nor a move writes, unless Ctrl/Cmd made a shortcut of
            # it. What it wrote is not looked at, so a run of typing is one run whatever the
            # words in it.
            if category == ERASE:
                kind = RUN_ERASE
            elif category == NAVIGATION:
                kind = RUN_NAV
            else:
                kind = RUN_OTHER if ctrl and not altgr else RUN_TYPE
            self._keystroke(kind, now)
            if kind == RUN_TYPE:
                self.last_typed = self.opened
            if undone:
                self._run(RUN_UNDO, now)
            # The mirror of the characters injected after a return: leaving the document,
            # reading something and coming back to **type** it is the second-screen gesture.
            if self.last_return and now - self.last_return < RETURN_WINDOW_S:
                w.keystrokes_after_return += 1
        if ctrl and letter == 's':
            return 'save'
        if w.keystrokes >= FLUSH_KEYSTROKES or self._crowded():
            return 'volume'
        return None

    def on_click(self, now):
        """Click in the body of the document: a navigation jump. Returns 'volume' when the
        window has to be sealed for its timeline, None otherwise."""
        self._mark(now)
        self.window.navigation += 1
        self._run(RUN_CLICK, now)
        self.nav_steps = NAV_STEPS_AWAY
        self._end_erase_run()
        # A click collapses whatever was selected. LibreOffice's handler reports no coordinates,
        # so a dragged selection cannot be told from a plain click here — unlike the browser
        # sensor, which measures the drag distance.
        self.selection_scope = None
        return 'volume' if self._crowded() else None

    def on_paste(self, now, text):
        """Paste (menu, shortcut or right-click): text is the clipboard's text. Returns 'volume'
        when the window has to be sealed for its timeline, None otherwise."""
        if not text:
            return None
        self._mark(now)
        # Pasting over a selection replaces it: "select everything, paste the answer" used to
        # count as an injection only, never as a revision.
        replaced = self._consume_selection()
        chars = len(text.replace('\r', '').replace('\n', ''))

        # The student's own text, come back from a corrector: a revision of what they wrote, not
        # a paste of someone else's words. It is scored as the block it replaces — one keystroke
        # for the block, as a deletion at the scale of a selection is — never as an injection.
        # Pasted a second time, it is a duplication: the paragraph was not revised twice over.
        own, again = self._restitution(now, text)
        if own:
            if not replaced and not again:
                self.window.macro_revisions += 1
            # The block pasted back is one keystroke, and neither typing nor erasing: a RUN_OTHER,
            # beside the run that says what came back. That second run is what lets the engine
            # tell a revision through a corrector from one made by hand — both weigh as a mass
            # revision — and how much came back: one run per gesture, with its size.
            self._keystroke(RUN_OTHER, now, pressed=False)
            self._run(RUN_SELF, now, chars)
            return 'volume' if self._crowded() else None

        self.window.paste_events += 1
        # One run per gesture, whatever its size: the engine counts the pastes by the runs and
        # the injected characters by their sizes — the largest one included, which a total
        # alone would hide.
        self._run(RUN_PASTE, now, chars)
        if chars > INJECTION_MIN_CHARS:
            self.window.injected_chars += chars
            # Brought back from outside: the student left the document, and what they pasted on
            # coming back arrived from wherever they went.
            if self.last_return and now - self.last_return < RETURN_WINDOW_S:
                self.window.injected_chars_after_return += chars
        return 'volume' if self._crowded() else None

    def on_focus_lost(self):
        self.window.focus_losses += 1
        self.away = True

    def on_focus_gained(self, now):
        """Back in the document after having left it. Nothing is counted and no window is
        opened: the return only dates what follows it, and only a departure that was counted
        opens one."""
        if not self.away:
            return
        self.away = False
        self.last_return = now

    # --- flush ---
    def take(self, reason='idle', volume=None, text=None):
        """Seals the window: returns (session, window), or None when there is nothing to seal.

        reason is the trigger that seals it, one of WIRE_FLUSH_REASONS. volume is Writer's
        count of the document, None when it could not be read; text is the reading of the
        document that count was taken with, when it is a new one — None when the count comes
        from the cache, or when the text could not be read.

        window is the window as the engine is sent it, key for key and in the order of the
        contract; only `offline` is not known here. Its number in the session and the totals of
        the session are settled in this operation, so a window that is sealed and never sent is
        still counted — and the next one shows it missing.
        """
        why = WIRE_FLUSH_REASONS[reason]
        self.last_activity = 0
        if not self.has_activity() and not self._crowded():
            # Clicks alone: their count carries over to the next window, but not their time,
            # otherwise the window would swallow the inactivity that follows. Their runs carry
            # over with them, and a click run has no duration to carry.
            self.window.at = None
            self.window.mono_start = None
            self.window.mono_last = None
            return None
        done = self.window
        self.window = Window()
        self.opened += 1

        if self.session is None:    # ended while the window was still open
            self.start_session()
        seq = self.seq
        self.seq += 1
        self.totals['keys'] += done.keystrokes
        self.totals['chars'] += done.injected_chars
        self.totals['pastes'] += done.paste_events
        window = {
            'seq': seq,
            # The first activity, on the wall clock and on the monotonic one, the second counted
            # from the start of the session; and how long the window lasted, on the monotonic
            # one alone. All three in whole milliseconds, and a window of a single instant
            # lasts one second: the engine takes no shorter.
            'at': round(done.at * 1000),
            'mono': max(0, round((done.mono_start - self.session_zero) * 1000)),
            'ms': max(round((done.mono_last - done.mono_start) * 1000), 1000),
            'why': why,
            'active': round(done.active_ms),
            'runs': done.timeline,
            'counts': {
                'corrections': done.corrections,
                'reformulations': done.reformulations,
                'revisions': done.macro_revisions,
                'jumps': done.navigation,
                'exits': done.focus_losses,
                'back_keys': done.keystrokes_after_return,
                'back_chars': done.injected_chars_after_return,
            },
        }
        # Without at least two flight times the rhythm is not measurable: the block is left out
        # rather than sent with a 0 that would skew an average. The histogram is of the very
        # values the median was read on.
        if len(done.flights) >= 2:
            window['flight'] = {'med': round(median(done.flights), 2),
                                'mad': round(median_absolute_deviation(done.flights), 2),
                                'bins': trimmed(histogram(done.flights, FLIGHT_BINS_MS))}
        # This sensor sees keys come back up, so the block is always there, zeros included: a
        # window that typed nothing says so rather than saying nothing.
        window['dwell'] = {'bins': trimmed(done.dwells), 'rollover': done.rollover}
        if volume is not None:
            # The size is Writer's count, and it is said whenever it is known. The span is only
            # said of a reading that is exactly that size, so the two cannot disagree: a count
            # the body text does not explain (a footnote, a frame) goes alone, and the reading
            # before it stays the one the next span is measured from. So does a count taken
            # from the cache, and the first reading of a session, which has nothing before it.
            window['text'] = {'len': volume}
            if text is not None and len(text) == volume:
                if self.previous_text is not None:
                    at, cut, add = text_span(self.previous_text, text)
                    window['text'].update(since=self.previous_text_seq, at=at, cut=cut, add=add)
                    kept = text_kept(self.previous_text[at:at + cut], text[at:at + add])
                    if kept is not None:
                        window['text']['kept'] = kept
                self.previous_text = text
                self.previous_text_seq = seq
        window['sum'] = dict(self.totals)
        return self.session, window
