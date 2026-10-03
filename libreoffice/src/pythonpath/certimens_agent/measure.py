"""Writing measurement windows: the logic of browser/content.js, without LibreOffice.

Receives already-translated events (key, click, paste, leaving the document) and keeps the
counters of one measurement window. No key is retained: only its category
(erase, navigation, shortcut) and the time of the keystroke. sensor.py wires this logic to
LibreOffice's events; tests/test_measure.py checks it without LibreOffice.
"""

import re
import unicodedata

FLUSH_KEYSTROKES = 200      # flush at 200 keystrokes, like the desktop agents
IDLE_FLUSH_S = 2.0          # flush after 2 s with no activity
# What the engine is told about *why* a window was sealed, for each of the triggers that can
# seal one. The engine cannot tell them apart on its own: a save cutting a burst in two looked,
# on its side, like a writer who never stops, and leaving the document looked like a pause for
# thought. Only 'away' and 'end' mean nobody was looking at the document.
#
# The wire vocabulary is six words and it is the same for the four agents (docs/mesures.md); the
# triggers on the left are this extension's own. A trigger missing from the table sends nothing,
# which the engine reads as an agent that did not say — `make check` is what keeps one from
# going missing.
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
PAUSE_MIN_S = 3             # cognitive pause: inactivity between 3 s and PAUSE_MAX_S then resuming
# PAUSE_MAX_S bounds what counts as thinking rather than leaving. It was 60 s, which made every
# deliberation longer than a minute count as *nothing at all* — neither a pause nor effective
# time — although pausing one to five minutes over a paragraph is the clearest mark of someone
# actually composing. Beyond five minutes the student has left the document, which is not
# cognitive friction. ACTIVE_GAP_MAX_S stays at 60 s: it bounds a different rule (what a gap adds
# to the effective time), and the two were only ever the same number by accident.
PAUSE_MAX_S = 300
ACTIVE_GAP_MAX_S = 60       # beyond this a gap adds nothing to the effective time
INJECTION_MIN_CHARS = 15    # a shorter paste is not counted as an injection
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
# A silence of one to three seconds, hands still on the keyboard: the writer is looking for a
# word. Shorter is a flight time, longer is a cognitive pause — the band between the two was
# measured nowhere, and it is the one thing someone retyping a finished text does not produce.
HESITATION_MIN_MS = 1000
HESITATION_MAX_MS = 3000

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
    """Counters for one measurement window."""

    def __init__(self):
        self.start = None
        self.last = None
        self.keystrokes = 0
        self.active_ms = 0
        self.injected_chars = 0
        self.injected_chars_max = 0
        self.injected_chars_after_return = 0
        self.corrections = 0
        self.reformulations = 0
        self.macro_revisions = 0
        self.navigation = 0
        self.pauses = 0
        self.paste_events = 0
        self.self_paste_events = 0
        self.self_paste_chars = 0
        self.focus_losses = 0
        self.hesitations = 0
        self.keystrokes_after_return = 0
        self.flights = []


class Measure:
    """Measurement of a document. Times are in seconds (time.time()).

    The on_* methods return the reason for an immediate flush ('save', 'volume') or None;
    the caller handles the idle delay (IDLE_FLUSH_S after last_activity()).
    """

    def __init__(self):
        self.window = Window()
        self.last_press = 0
        self.last_event = 0
        self.last_activity = 0
        self.is_navigating = False
        self.clicked_recently = False
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

    # --- restitution of one's own text ---
    def on_copy(self, now, text):
        """Copy or cut: what leaves the document is remembered, hashed, so that it can be
        recognised if it comes back. Not an activity of its own — the Ctrl+C is already counted
        as a keystroke, and a copy opens no measurement window."""
        if not text:
            return
        marks = shingles(text)
        if not marks:    # nothing but punctuation: no words to recognise later
            return
        self.own_text.append(_Copy(frozenset(marks), now))
        if len(self.own_text) > SELF_PASTE_MAX_COPIES:
            # The memory is bounded, and what goes is the copy nothing has come back to for the
            # longest — not the oldest one. Copying five other things in between would otherwise
            # make the block the student is still pasting unrecognisable.
            self.own_text.remove(min(self.own_text, key=lambda copy: copy.seen_at))

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
        if self.window.start is None:
            self.window.start = now
        self.window.last = now

    def _pause(self, now):
        """Resuming after 3 s to PAUSE_MAX_S of inactivity counts as a cognitive pause."""
        if self.last_event > 0:
            gap = now - self.last_event
            if PAUSE_MIN_S < gap <= PAUSE_MAX_S:
                self.window.pauses += 1
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
        return self.window.keystrokes > 0 or self.window.paste_events > 0

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
    def on_key(self, now, category, ctrl=False, letter=None, shift=False):
        """Key pressed (excluding auto-repeat). letter: 's', 'x', 'z'… with Ctrl/Cmd.

        A PASTE key opens a window, dates what follows and feeds the rhythm like any other, but
        does not count a keystroke of its own: see the end of this method.
        """
        # A modifier pressed on its own is not a keystroke: it writes nothing, and the near-zero
        # gap it leaves before the character it modifies would pass for an impossibly fast one.
        # browser/content.js drops it the same way; Word and VS Code, counting characters,
        # never see one. Dropped before anything else, so a Shift pressed between a click and a
        # Backspace no longer spends the click either.
        if category == MODIFIER:
            return None
        w = self.window
        self._mark(now)
        self._pause(now)
        if self.last_press > 0:
            flight = (now - self.last_press) * 1000
            if flight < FLIGHT_MAX_MS:
                w.flights.append(flight)
                if len(w.flights) > MAX_FLIGHTS:
                    w.flights.pop(0)
            elif HESITATION_MIN_MS <= flight <= HESITATION_MAX_MS:
                # The band between a flight time and a cognitive pause: someone searching for a
                # word. It used to fall through both rules and be counted nowhere.
                w.hesitations += 1
        self.last_press = now

        # Ctrl+A selects the whole document; Shift with a navigation key extends a selection.
        # Shift alone must not count: it is also how capitals are typed.
        if ctrl and letter == 'a':
            self.selection_scope = 'all'
        elif shift and category == NAVIGATION:
            self.selection_scope = 'range'

        if category == ERASE:
            # Erasing a selection is scored by what it spans, not by what preceded it.
            if self._consume_selection():
                pass
            elif self.clicked_recently:
                w.macro_revisions += 1
            elif self.is_navigating:
                w.reformulations += 1
            else:
                w.corrections += 1
            # The jump is spent on this deletion: what follows is erased on the spot and counts
            # as immediate corrections (browser/content.js does the same).
            self.is_navigating = False
        elif category == NAVIGATION:
            w.navigation += 1
            self.is_navigating = True
            # A navigation without Shift collapses the selection instead of extending it.
            if not shift:
                self.selection_scope = None
        else:
            # A character typed over a selection replaces it. Ctrl shortcuts act on the selection
            # (copy, select-all) rather than replacing it, so they are excluded.
            if not ctrl:
                self._consume_selection()
            self.is_navigating = False
        self.clicked_recently = False

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
        if ctrl and letter == 'z':
            self.selection_scope = None
            if not shift:
                w.corrections += 1

        self._active_time(now)
        # A paste does write — but what it writes is weighed in on_paste, one keystroke for the
        # student's own text coming back and none for an injection, and weighed there whatever
        # pasted it: the menu and the toolbar have no key to count. Counting the key as well made
        # the same gesture cost two keystrokes from the keyboard and one from the menu
        # (browser/content.js drops it the same way). Ctrl/Cmd+C stays an ordinary keystroke: it
        # puts nothing into the document, so nothing else counts it.
        if category != PASTE:
            w.keystrokes += 1
            # The mirror of injected_chars_after_return: leaving the document, reading something
            # and coming back to **type** it is the second-screen gesture, and no counter saw it.
            if self.last_return and now - self.last_return < RETURN_WINDOW_S:
                w.keystrokes_after_return += 1
        if ctrl and letter == 's':
            return 'save'
        if w.keystrokes >= FLUSH_KEYSTROKES:
            return 'volume'
        return None

    def on_click(self, now):
        """Click in the body of the document: a navigation jump."""
        self._mark(now)
        self._pause(now)
        self.window.navigation += 1
        self.is_navigating = True
        self.clicked_recently = True
        # A click collapses whatever was selected. LibreOffice's handler reports no coordinates,
        # so a dragged selection cannot be told from a plain click here — unlike the browser
        # sensor, which measures the drag distance.
        self.selection_scope = None

    def on_paste(self, now, text):
        """Paste (menu, shortcut or right-click): text is the clipboard's text."""
        if not text:
            return
        self._mark(now)
        self._pause(now)
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
            self.window.keystrokes += 1
            # Counted so the engine can tell a revision through a corrector from a revision made
            # by hand: both weigh as a mass revision, and only this says which one it was.
            self.window.self_paste_events += 1
            # And how much came back, not only how often: four restitutions say nothing about
            # whether a paragraph or a third of the document went through the corrector.
            self.window.self_paste_chars += chars
            return

        self.window.paste_events += 1
        if chars > INJECTION_MIN_CHARS:
            self.window.injected_chars += chars
            # The largest single injection, which the total alone hides: twenty pastes of a
            # hundred characters and one of two thousand give the same total.
            self.window.injected_chars_max = max(self.window.injected_chars_max, chars)
            # Brought back from outside: the student left the document, and what they pasted on
            # coming back arrived from wherever they went.
            if self.last_return and now - self.last_return < RETURN_WINDOW_S:
                self.window.injected_chars_after_return += chars

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
    def take(self, volume=None):
        """Ends the window: returns (period, values) to send, or None if there was no activity."""
        self.last_activity = 0
        if not self.has_activity():
            # Clicks alone: their counters carry over to the next window, but not their time,
            # otherwise the period would swallow the inactivity that follows.
            self.window.start = None
            self.window.last = None
            return None
        done = self.window
        self.window = Window()
        end = max(done.last, done.start + 1)  # the engine requires end > start
        values = {
            'effective_time_ms': round(done.active_ms),
            'keystrokes_total': done.keystrokes,
            'injected_chars_total': done.injected_chars,
            'immediate_corrections': done.corrections,
            'deferred_reformulations': done.reformulations,
            'navigation_jumps': done.navigation,
            'macro_revisions': done.macro_revisions,
            'cognitive_pauses': done.pauses,
            'paste_events': done.paste_events,
            'self_paste_events': done.self_paste_events,
            'self_paste_chars_total': done.self_paste_chars,
            'lexical_hesitations': done.hesitations,
            'keystrokes_after_return': done.keystrokes_after_return,
            'injected_chars_max': done.injected_chars_max,
            'injected_chars_after_return': done.injected_chars_after_return,
            'focus_losses': done.focus_losses,
        }
        # Without at least two flight times, the rhythm is not measurable: we send nothing
        # rather than a 0 that would skew the average.
        if len(done.flights) >= 2:
            values['flight_mad_ms'] = round(median_absolute_deviation(done.flights), 2)
            values['flight_median_ms'] = round(median(done.flights), 2)
        if volume is not None:
            values['real_volume_chars'] = volume
        return (done.start, end), values
