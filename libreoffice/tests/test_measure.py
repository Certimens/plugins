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
