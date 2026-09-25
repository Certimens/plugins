"""Definitions of measure.py (the same as extension/content.js)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'pythonpath'))

from certimens_agent import measure as m  # noqa: E402


def type_keys(measure, start, count, interval=0.15, category=m.OTHER):
    t = start
    for _ in range(count):
        measure.on_key(t, category)
        t += interval
    return t


class MeasureTest(unittest.TestCase):
    def test_typing_rhythm(self):
        measure = m.Measure()
        type_keys(measure, 1000, 10, interval=0.2)
        (start, end), values = measure.take(volume=42)
        self.assertEqual(values['total_keystrokes'], 10)
        self.assertEqual(values['median_flight_ms'], 200)
        self.assertEqual(values['mad_ms'], 0)
        self.assertEqual(values['effective_time_seconds'], 2)  # 9 gaps of 200 ms
        self.assertEqual(values['real_volume'], 42)
        self.assertAlmostEqual(end - start, 1.8)

    def test_erase_context(self):
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.ERASE)                     # right after typing: correction
        measure.on_key(t + 0.2, m.NAVIGATION)
        measure.on_key(t + 0.4, m.ERASE)               # after a move: reformulation
        measure.on_click(t + 0.6)
        measure.on_key(t + 0.8, m.ERASE)               # after a click: macro-revision
        measure.on_key(t + 1.0, m.OTHER, ctrl=True, letter='x')
        measure.on_key(t + 1.2, m.OTHER, ctrl=True, letter='z')
        _, values = measure.take()
        self.assertEqual(values['immediate_corrections'], 2)   # erase + Ctrl+Z
        self.assertEqual(values['deferred_reformulations'], 1)
        self.assertEqual(values['macro_revisions'], 2)         # erase after click + Ctrl+X
        self.assertEqual(values['navigation_jumps'], 2)        # arrow + click

    def test_erasing_in_a_row_counts_as_corrections(self):
        """A jump is spent on the first deletion: the ones that follow are made on the spot."""
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_click(t)
        for i in range(4):
            measure.on_key(t + 0.2 + i * 0.1, m.ERASE)
        _, values = measure.take()
        self.assertEqual(values['macro_revisions'], 1)         # the first, right after the click
        self.assertEqual(values['immediate_corrections'], 3)   # the rest, erased on the spot
        self.assertEqual(values['deferred_reformulations'], 0)

    def test_pause_and_paste(self):
        measure = m.Measure()
        t = type_keys(measure, 1000, 2)
        measure.on_key(t + 10, m.OTHER)                # resume after 10 s: cognitive pause
        measure.on_paste(t + 11, 'court')              # short paste: counted, not injected
        measure.on_paste(t + 12, 'un long texte collé\nsur deux lignes')
        _, values = measure.take()
        self.assertEqual(values['cognitive_pauses'], 1)
        self.assertEqual(values['paste_events'], 2)
        self.assertEqual(values['total_injected_chars'], len('un long texte collésur deux lignes'))

    def test_flush_triggers(self):
        measure = m.Measure()
        self.assertEqual(measure.on_key(1000, m.OTHER, ctrl=True, letter='s'), 'save')
        measure = m.Measure()
        reasons = [measure.on_key(1000 + i * 0.1, m.OTHER) for i in range(m.FLUSH_KEYSTROKES)]
        self.assertEqual(reasons[-1], 'volume')

    def test_clicks_only_send_nothing(self):
        measure = m.Measure()
        measure.on_click(1000)
        self.assertIsNone(measure.take())
        type_keys(measure, 2000, 2)
        (start, _), values = measure.take()
        self.assertEqual(start, 2000)                  # the click's time is not kept
        self.assertEqual(values['navigation_jumps'], 1)  # but its counter is

    def test_single_keystroke_has_no_rhythm(self):
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        (start, end), values = measure.take()
        self.assertNotIn('mad_ms', values)
        self.assertEqual(end - start, 1)               # the engine requires end > start


if __name__ == '__main__':
    unittest.main()


class SelectionReplacementTest(unittest.TestCase):
    """Typing or pasting over a selection deletes what it spans. The sensor used to watch only
    the erase keys, so replacing a selection cost nothing — the cheapest way to rewrite a
    document without a single revision being counted."""

    def test_typing_over_a_select_all_is_a_mass_revision(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER)  # a character replaces the whole document
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.reformulations, 0)

    def test_typing_over_a_shift_selection_is_a_reformulation(self):
        measure = m.Measure()
        measure.on_key(0.0, m.NAVIGATION, shift=True)
        measure.on_key(0.2, m.OTHER)
        self.assertEqual(measure.window.reformulations, 1)
        self.assertEqual(measure.window.macro_revisions, 0)

    def test_pasting_over_a_selection_is_a_revision_and_an_injection(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_paste(0.2, 'x' * 500)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.injected_chars, 500)

    def test_erasing_a_selection_is_scored_by_its_span(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.ERASE)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.corrections, 0)

    def test_a_selection_is_spent_only_once(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER)
        measure.on_key(0.4, m.OTHER)
        measure.on_key(0.6, m.OTHER)
        self.assertEqual(measure.window.macro_revisions, 1)

    def test_shift_alone_does_not_select(self):
        """Shift is also how capitals are typed: only Shift with a navigation key selects."""
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, shift=True)
        measure.on_key(0.2, m.OTHER, shift=True)
        self.assertEqual(measure.window.macro_revisions, 0)
        self.assertEqual(measure.window.reformulations, 0)

    def test_a_plain_navigation_collapses_the_selection(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.NAVIGATION)  # arrow without Shift: the selection is gone
        measure.on_key(0.4, m.OTHER)
        self.assertEqual(measure.window.macro_revisions, 0)

    def test_cutting_a_selection_is_not_charged_twice(self):
        """Ctrl+X on a selection *is* the deletion it was waiting for. Left pending, the
        selection was spent again by the next keystroke: one cut, two mass revisions."""
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER, ctrl=True, letter='x')   # the cut removes the selection
        measure.on_key(0.4, m.OTHER)                          # typing in its place
        self.assertEqual(measure.window.macro_revisions, 1)

    def test_cut_then_paste_is_one_revision(self):
        """Moving a block (select, cut, paste elsewhere) is a single mass revision."""
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER, ctrl=True, letter='x')
        measure.on_paste(0.4, 'x' * 500)
        self.assertEqual(measure.window.macro_revisions, 1)

    def test_undo_does_not_leave_a_selection_pending(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER, ctrl=True, letter='z')
        measure.on_key(0.4, m.OTHER)
        self.assertEqual(measure.window.macro_revisions, 0)

    def test_copying_keeps_the_selection(self):
        """Ctrl+C does not delete anything: what is typed next still replaces the selection."""
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_key(0.2, m.OTHER, ctrl=True, letter='c')
        measure.on_key(0.4, m.OTHER)
        self.assertEqual(measure.window.macro_revisions, 1)

    def test_a_click_collapses_the_selection(self):
        measure = m.Measure()
        measure.on_key(0.0, m.OTHER, ctrl=True, letter='a')
        measure.on_click(0.2)
        measure.on_key(0.4, m.OTHER)
        self.assertEqual(measure.window.macro_revisions, 0)


class PauseCeilingTest(unittest.TestCase):
    """A deliberation of one to five minutes is the clearest mark of someone composing. With the
    old 60 s ceiling it counted as nothing at all — neither a pause nor effective time."""

    # The first keystroke only sets the reference; a gap is measured from it (see _pause), and a
    # zero timestamp would read as "no previous event".
    T0 = 1000.0

    def test_a_two_minute_gap_is_a_pause(self):
        measure = m.Measure()
        measure.on_key(self.T0, m.OTHER)
        measure.on_key(self.T0 + 120.0, m.OTHER)  # resumed after two minutes
        self.assertEqual(measure.window.pauses, 1)

    def test_a_break_longer_than_the_ceiling_is_not_a_pause(self):
        measure = m.Measure()
        measure.on_key(self.T0, m.OTHER)
        measure.on_key(self.T0 + m.PAUSE_MAX_S + 60.0, m.OTHER)  # the student left
        self.assertEqual(measure.window.pauses, 0)

    def test_a_gap_below_the_minimum_is_typing_flow(self):
        measure = m.Measure()
        measure.on_key(self.T0, m.OTHER)
        measure.on_key(self.T0 + 1.0, m.OTHER)
        self.assertEqual(measure.window.pauses, 0)

    def test_effective_time_still_stops_at_its_own_ceiling(self):
        """Raising the pause ceiling must not credit long gaps as typing time: the two rules were
        only ever sharing a constant by accident."""
        measure = m.Measure()
        measure.on_key(self.T0, m.OTHER)
        measure.on_key(self.T0 + 120.0, m.OTHER)  # counts as a pause, but adds no effective time
        self.assertEqual(measure.window.pauses, 1)
        self.assertEqual(measure.window.active_ms, 0)
