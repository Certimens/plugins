"""Writing measurement windows: the logic of extension/content.js, without LibreOffice.

Receives already-translated events (key, click, paste, leaving the document) and keeps the
counters of one measurement window. No key is retained: only its category
(erase, navigation, shortcut) and the time of the keystroke. sensor.py wires this logic to
LibreOffice's events; tests/test_measure.py checks it without LibreOffice.
"""

FLUSH_KEYSTROKES = 200      # flush at 200 keystrokes, like the desktop agents
IDLE_FLUSH_S = 2.0          # flush after 2 s with no activity
FLIGHT_MAX_MS = 800         # beyond this, the gap between two keystrokes is not a "flight time"
PAUSE_MIN_S = 3             # cognitive pause: inactivity between 3 and 60 s then resuming
PAUSE_MAX_S = 60
INJECTION_MIN_CHARS = 15    # a shorter paste is not counted as an injection
MAX_FLIGHTS = 500

# Key categories (sensor.py translates the com.sun.star.awt.Key codes).
ERASE = 'erase'             # Backspace, Delete
NAVIGATION = 'navigation'   # arrows, Home/End, Page Up/Down
MODIFIER = 'modifier'       # a modifier key alone
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


class Window:
    """Counters for one measurement window."""

    def __init__(self):
        self.start = None
        self.last = None
        self.keystrokes = 0
        self.active_ms = 0
        self.injected_chars = 0
        self.corrections = 0
        self.reformulations = 0
        self.macro_revisions = 0
        self.navigation = 0
        self.pauses = 0
        self.paste_events = 0
        self.focus_losses = 0
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

    # --- activity ---
    def _mark(self, now):
        if self.window.start is None:
            self.window.start = now
        self.window.last = now

    def _pause(self, now):
        """Resuming after 3 to 60 s of inactivity counts as a cognitive pause."""
        if self.last_event > 0:
            gap = now - self.last_event
            if PAUSE_MIN_S < gap <= PAUSE_MAX_S:
                self.window.pauses += 1
        self.last_event = now

    def _active_time(self, now):
        """Effective time: the real gap if <= 2 s, a flat 250 ms if < 60 s, nothing beyond."""
        if self.last_activity > 0:
            gap_ms = (now - self.last_activity) * 1000
            if gap_ms <= 2000:
                self.window.active_ms += gap_ms
            elif gap_ms < PAUSE_MAX_S * 1000:
                self.window.active_ms += 250
        self.last_activity = now

    def has_activity(self):
        return self.window.keystrokes > 0 or self.window.paste_events > 0

    # --- events ---
    def on_key(self, now, category, ctrl=False, letter=None):
        """Key pressed (excluding auto-repeat). letter: 's', 'x', 'z'… with Ctrl/Cmd."""
        w = self.window
        self._mark(now)
        self._pause(now)
        if self.last_press > 0:
            flight = (now - self.last_press) * 1000
            if flight < FLIGHT_MAX_MS:
                w.flights.append(flight)
                if len(w.flights) > MAX_FLIGHTS:
                    w.flights.pop(0)
        self.last_press = now

        if category == ERASE:
            if self.clicked_recently:
                w.macro_revisions += 1
            elif self.is_navigating:
                w.reformulations += 1
            else:
                w.corrections += 1
            # The jump is spent on this deletion: what follows is erased on the spot and counts
            # as immediate corrections (extension/content.js does the same).
            self.is_navigating = False
        elif category == NAVIGATION:
            w.navigation += 1
            self.is_navigating = True
        elif category != MODIFIER:
            self.is_navigating = False
        self.clicked_recently = False

        if ctrl and letter == 'x':
            w.macro_revisions += 1
        if ctrl and letter == 'z':
            w.corrections += 1

        self._active_time(now)
        w.keystrokes += 1
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

    def on_paste(self, now, text):
        """Paste (menu, shortcut or right-click): text is the clipboard's text."""
        if not text:
            return
        self._mark(now)
        self._pause(now)
        self.window.paste_events += 1
        chars = len(text.replace('\r', '').replace('\n', ''))
        if chars > INJECTION_MIN_CHARS:
            self.window.injected_chars += chars

    def on_focus_lost(self):
        self.window.focus_losses += 1

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
            'effective_time_seconds': round(done.active_ms / 1000),
            'total_keystrokes': done.keystrokes,
            'total_injected_chars': done.injected_chars,
            'immediate_corrections': done.corrections,
            'deferred_reformulations': done.reformulations,
            'navigation_jumps': done.navigation,
            'macro_revisions': done.macro_revisions,
            'cognitive_pauses': done.pauses,
            'paste_events': done.paste_events,
            'focus_losses': done.focus_losses,
        }
        # Without at least two flight times, the rhythm is not measurable: we send nothing
        # rather than a 0 that would skew the average.
        if len(done.flights) >= 2:
            values['mad_ms'] = round(median_absolute_deviation(done.flights), 2)
            values['median_flight_ms'] = round(median(done.flights), 2)
        if volume is not None:
            values['real_volume'] = volume
        return (done.start, end), values
