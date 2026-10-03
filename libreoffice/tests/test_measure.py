"""Definitions of measure.py (the same as browser/content.js)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

from certimens_agent import measure as m

KEYSTROKE_RUNS = (m.RUN_TYPE, m.RUN_ERASE, m.RUN_NAV, m.RUN_OTHER)


def type_keys(measure, start, count, interval=0.15, category=m.OTHER):
    t = start
    for _ in range(count):
        measure.on_key(t, category)
        t += interval
    return t


def sealed(measure, *args, **reading):
    """The window measure.take seals, as the engine is sent it."""
    return measure.take(*args, **reading)[1]


def runs_of(window, *kinds):
    return [run for run in window['runs'] if run[0] in kinds]


def keystrokes(window):
    """What the engine reads as the keystrokes of a window: the runs that are keystrokes."""
    return sum(run[1] for run in runs_of(window, *KEYSTROKE_RUNS))


def gaps(window):
    return [run[1] for run in runs_of(window, m.RUN_GAP)]


class MeasureTest(unittest.TestCase):
    def test_typing_rhythm(self):
        measure = m.Measure()
        type_keys(measure, 1000, 10, interval=0.2)
        window = sealed(measure, volume=42)
        self.assertEqual(window['runs'], [['type', 10, 1800]])
        self.assertEqual(window['flight'], {'med': 200, 'mad': 0, 'bins': [0, 0, 0, 0, 0, 0, 0, 0, 9]})
        self.assertEqual(window['active'], 1800)       # 9 gaps of 200 ms
        self.assertEqual(window['text'], {'len': 42})
        self.assertEqual((window['mono'], window['ms']), (0, 1800))

    def test_erase_context(self):
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.ERASE)                     # right after typing: correction
        measure.on_key(t + 0.2, m.NAVIGATION)
        measure.on_key(t + 0.4, m.ERASE)               # after a move: reformulation
        measure.on_click(t + 0.6)
        measure.on_key(t + 0.8, m.ERASE)               # after a click: deferred reformulation
        measure.on_key(t + 1.0, m.OTHER, ctrl=True, letter='x')
        measure.on_key(t + 1.2, m.OTHER, ctrl=True, letter='z')
        counts = sealed(measure)['counts']
        self.assertEqual(counts['corrections'], 2)             # erase + Ctrl+Z
        self.assertEqual(counts['reformulations'], 2)          # after a move, and after a click
        self.assertEqual(counts['revisions'], 1)               # Ctrl+X alone: a block gesture
        self.assertEqual(counts['jumps'], 2)                   # arrow + click

    def test_erasing_in_a_row_counts_as_corrections(self):
        """A trip is spent on the first deletion: the ones that follow are made on the spot.

        A plain click is a local retouch, not a restructuring — clicking into a word three lines
        up and taking its ending off is the deferred reformulation the counter is named for. Mass
        revisions are the block gestures alone (Ctrl+A replaced, Ctrl+X), which is what makes
        their weight in the revision rate defensible.
        """
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_click(t)
        for i in range(4):
            measure.on_key(t + 0.2 + i * 0.1, m.ERASE)
        counts = sealed(measure)['counts']
        self.assertEqual(counts['reformulations'], 1)           # the first, right after the click
        self.assertEqual(counts['corrections'], 3)              # the rest, erased on the spot
        self.assertEqual(counts['revisions'], 0)

    def test_a_word_erased_and_a_long_run_are_reformulations(self):
        """The shapes the rule used to drop into immediate corrections.

        Neither touches an arrow before erasing, and that was the only door into the
        reformulation branch — which is why that counter stayed empty while corrections filled up.
        """
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.ERASE, ctrl=True)              # a whole word, in one press
        measure.on_key(t + 0.1, m.OTHER)                   # ends the run
        for i in range(9):                                 # a phrase, one key at a time
            measure.on_key(t + 0.2 + i * 0.1, m.ERASE)
        counts = sealed(measure)['counts']
        self.assertEqual(counts['reformulations'], 2)
        # Only the erases before the run crossed the threshold; past it the run is one gesture.
        self.assertEqual(counts['corrections'], 5)
        self.assertEqual(counts['revisions'], 0)

    def test_an_insertion_after_a_trip_is_a_reformulation(self):
        """Going back to insert the word that was missing, erasing nothing.

        The branch used to drop the trip in silence, so this produced navigation jumps and no
        reformulation at all. One arrow is a brush against the key and still counts for nothing.
        """
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.NAVIGATION)
        measure.on_key(t + 0.1, m.NAVIGATION)
        measure.on_key(t + 0.2, m.OTHER)
        measure.on_key(t + 0.3, m.NAVIGATION)              # a single press: a brush
        measure.on_key(t + 0.4, m.OTHER)
        counts = sealed(measure)['counts']
        self.assertEqual(counts['reformulations'], 1)
        self.assertEqual(counts['corrections'], 0)

    def test_a_key_held_down_is_one_deletion_and_a_phrase_one_reformulation(self):
        """A repeat is not a keystroke, but the characters a held Backspace takes out are a run
        like any other -- the two sensors that read the text see exactly that."""
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.ERASE)
        for _ in range(8):
            measure.on_held_erase()
        window = sealed(measure)
        self.assertEqual(keystrokes(window), 4)
        self.assertEqual(window['counts']['corrections'], 1)
        self.assertEqual(window['counts']['reformulations'], 1)

    def test_a_jump_is_a_trip_on_its_own_and_an_arrow_is_not(self):
        """Home, a page or Ctrl+arrow crosses a word or a line in one press."""
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.NAVIGATION, jump=True)
        measure.on_key(t + 0.2, m.OTHER)
        self.assertEqual(measure.window.reformulations, 1)
        measure = m.Measure()
        t = type_keys(measure, 1000, 3)
        measure.on_key(t, m.NAVIGATION)
        measure.on_key(t + 0.2, m.OTHER)
        self.assertEqual(measure.window.reformulations, 0)

    def test_silence_and_paste(self):
        measure = m.Measure()
        t = type_keys(measure, 1000, 2, 0.25)
        measure.on_key(t + 10, m.OTHER)                # typing resumes after a silence
        measure.on_paste(t + 11, 'court')              # short paste: a paste, not an injection
        measure.on_paste(t + 12, 'un long texte collé\nsur deux lignes')
        window = sealed(measure)
        long = len('un long texte collésur deux lignes')
        self.assertEqual(window['runs'], [['type', 2, 250], ['gap', 10250], ['type', 1, 0],
                                          ['paste', 5], ['paste', long]])
        # The totals of the session count both pastes, and only the long one as injected.
        self.assertEqual(window['sum'], {'keys': 3, 'chars': long, 'pastes': 2})

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
        window = sealed(measure)
        # The click's time is not kept: the window starts a thousand seconds into the session
        # the click opened.
        self.assertEqual((window['mono'], window['ms']), (1000000, 1000))
        self.assertEqual(window['counts']['jumps'], 1)  # but its count is

    def test_single_keystroke_has_no_rhythm(self):
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        window = sealed(measure)
        self.assertNotIn('flight', window)
        self.assertEqual(window['ms'], 1000)           # the engine takes no shorter window


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

    def test_a_bare_modifier_is_not_a_keystroke(self):
        """Shift, Ctrl or Alt pressed on its own writes nothing.

        Counting one inflated the keystrokes of everyone who types capitals, and its
        near-zero gap before the character it modifies passed for an impossibly fast one —
        exactly what the flight times exist to tell apart. Word and VS Code, which
        count characters, never see one: the rule is the same in the four agents.
        """
        measure = m.Measure()
        measure.on_key(0.00, m.MODIFIER)
        measure.on_key(0.02, m.OTHER, shift=True)
        measure.on_key(0.20, m.MODIFIER)
        measure.on_key(0.22, m.OTHER, shift=True)
        self.assertEqual(measure.window.keystrokes, 2)
        # From one capital to the next, not from Shift to the letter it modifies.
        self.assertEqual([round(f) for f in measure.window.flights], [200])

    def test_a_modifier_does_not_spend_the_click_before_it(self):
        """Shift pressed between a click and a Backspace: still read as the click's deletion."""
        measure = m.Measure()
        measure.on_click(0.0)
        measure.on_key(0.2, m.MODIFIER)
        measure.on_key(0.4, m.ERASE)
        self.assertEqual(measure.window.reformulations, 1)
        self.assertEqual(measure.window.corrections, 0)
        self.assertEqual(measure.window.macro_revisions, 0)

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


class SilenceTest(unittest.TestCase):
    """A silence between two counted keystrokes is said in the timeline from one second on, at
    its real length. The sensor does not classify it: whether it is a word being looked for, a
    pause for thought or a departure is the engine's reading of that length."""

    # The first keystroke only sets the reference; a silence is measured from it (see
    # _silence), and a zero timestamp would read as "no previous event".
    T0 = 1000.0

    def silences(self, *events):
        """The silences in the timeline once the events have been played, an event being
        (seconds after T0, method name, further arguments)."""
        measure = m.Measure()
        for after, name, *args in events:
            getattr(measure, name)(self.T0 + after, *args)
        return measure, [run[1] for run in measure.window.timeline if run[0] == m.RUN_GAP]

    def test_a_silence_is_said_from_one_second_on(self):
        cases = [(0.2, []), (0.9994, []), (0.9996, [1000]), (1.0, [1000]), (1.6, [1600]),
                 (2.9996, [3000]), (3.0004, [3000]), (4.0, [4000]), (120.0, [120000])]
        for silence, expected in cases:
            with self.subTest(silence=silence):
                _, said = self.silences((0, 'on_key', m.OTHER), (silence, 'on_key', m.OTHER))
                self.assertEqual(said, expected)

    def test_a_silence_is_said_at_its_real_length_however_long(self):
        """Nothing caps it: an hour away from the keyboard is an hour, and it is the engine
        that reads a departure in it rather than a pause."""
        _, said = self.silences((0, 'on_key', m.OTHER), (3600, 'on_key', m.OTHER))
        self.assertEqual(said, [3600000])

    def test_the_one_bound_the_sensor_holds_is_where_a_silence_starts_being_said(self):
        self.assertEqual(m.GAP_MIN_MS, 1000)

    def test_effective_time_stops_at_its_own_ceiling(self):
        """A long silence is said, and adds nothing to the time spent typing: the two rules
        have nothing to do with each other."""
        measure, said = self.silences((0, 'on_key', m.OTHER), (120, 'on_key', m.OTHER))
        self.assertEqual(said, [120000])
        self.assertEqual(measure.window.active_ms, 0)

    def test_a_silence_ended_by_anything_but_a_keystroke_is_not_said(self):
        """A silence is between two *keystrokes*. A click, a paste and the PASTE key count no
        keystroke, so they end no silence — and start none."""
        measure, said = self.silences((0, 'on_key', m.OTHER), (10, 'on_click'),
                                      (20, 'on_key', m.PASTE, True, 'v'), (30, 'on_paste', 'x' * 500))
        self.assertEqual(said, [])
        self.assertEqual(measure.window.keystrokes, 1)

    def test_a_silence_spent_clicking_is_one_silence_when_typing_resumes(self):
        _, said = self.silences((0, 'on_key', m.OTHER), (10, 'on_click'), (20, 'on_click'),
                                (30, 'on_key', m.OTHER))
        self.assertEqual(said, [30000])     # one thought, not three

    def test_one_silence_is_read_once_whatever_was_pressed_in_it(self):
        """Stopping two seconds, pressing the paste shortcut and typing again is one silence of
        four seconds: the shortcut is a key pressed, not a keystroke counted."""
        measure, _ = self.silences((0, 'on_key', m.OTHER), (2, 'on_key', m.PASTE, True),
                                   (4, 'on_key', m.OTHER))
        self.assertEqual(sealed(measure)['runs'], [['type', 1, 0], ['gap', 4000], ['type', 1, 0]])

    def test_a_shortcut_inside_a_silence_leaves_the_flight_times_alone(self):
        measure, _ = self.silences((0, 'on_key', m.OTHER), (1, 'on_key', m.PASTE, True),
                                   (1.5, 'on_key', m.OTHER))
        self.assertEqual(measure.window.flights, [500.0])   # the flight times still read every key
        self.assertEqual(sealed(measure)['runs'], [['type', 1, 0], ['gap', 1500], ['type', 1, 0]])


# A student's paragraph, and what a spell-checker gives back: the same words, a few of them
# fixed. The browser suite (browser/tests/sensor.test.mjs) runs the same cases on the same texts.
WRITTEN = """La mesure de la rédaction repose sur des compteurs et jamais sur le texte lui même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seul."""

CORRECTED = """La mesure de la rédaction repose sur des compteurs et jamais sur le texte lui-même.
Chaque fenêtre de mesure part vers le moteur avec sa période et ses valeurs.
L'étudiant garde son texte sur son poste, ce qui est la promesse du produit.
Aucune touche n'est enregistrée et aucun caractère ne quitte l'ordinateur de l'étudiant.
Les quatre agents partagent la même définition des mesures et chacun l'implémente seul."""

FOREIGN = """L'intelligence artificielle transforme radicalement les méthodes de travail
contemporaines dans presque tous les secteurs économiques connus, et cette évolution rapide
soulève des questions inédites pour les établissements d'enseignement supérieur français."""


class RestitutionTest(unittest.TestCase):
    """A text passed through a corrector and pasted back is the student's own writing."""

    def test_corrected_text_is_a_revision_not_an_injection(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.paste_events, 0)
        self.assertEqual(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.keystrokes, 1)

    def test_over_a_selection_the_revision_is_counted_once(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_key(130.0, m.OTHER, ctrl=True, letter='a')
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.injected_chars, 0)

    def test_foreign_text_is_still_an_injection(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, FOREIGN)
        self.assertEqual(measure.window.paste_events, 1)
        self.assertEqual(measure.window.injected_chars,
                         len(FOREIGN.replace('\r', '').replace('\n', '')))
        self.assertEqual(measure.window.macro_revisions, 0)

    def test_nothing_copied_means_an_injection(self):
        measure = m.Measure()
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.paste_events, 1)
        self.assertGreater(measure.window.injected_chars, 0)

    def test_pasted_again_it_never_becomes_an_injection(self):
        """Copy once, paste the block several times: none of them is a paste of foreign text, and
        the paragraph was not revised three times over."""
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, CORRECTED)
        measure.on_paste(640.0, CORRECTED)
        measure.on_paste(1140.0, CORRECTED)
        self.assertEqual(measure.window.paste_events, 0)
        self.assertEqual(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.keystrokes, 3)

    def test_the_delay_runs_from_the_last_paste_not_from_the_copy(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(100.0 + m.SELF_PASTE_TTL_S - 100, CORRECTED)
        # Past the delay counted from the copy, within it counted from the paste: what is still
        # in use stays comparable.
        measure.on_paste(100.0 + 2 * m.SELF_PASTE_TTL_S - 200, CORRECTED)
        self.assertEqual(measure.window.paste_events, 0)

    def test_what_keeps_coming_back_survives_the_memory_filling_up(self):
        # Filling the memory is the whole point: below the bound nothing is ever forgotten, and
        # the test would pass without telling which copy goes.
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        for i in range(m.SELF_PASTE_MAX_COPIES - 1):
            measure.on_copy(110.0 + i, f"bloc {i} sans aucun rapport avec ce que rédige l'étudiant")
        measure.on_paste(200.0, CORRECTED)     # the block is the most recently seen again
        measure.on_copy(210.0, "un bloc de trop, sans aucun rapport avec ce que rédige l'étudiant")
        measure.on_paste(220.0, CORRECTED)
        self.assertEqual(measure.window.paste_events, 0)

    def test_what_was_copied_is_forgotten_once_the_delay_has_run_out(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(100.0 + m.SELF_PASTE_TTL_S + 1, CORRECTED)
        self.assertEqual(measure.window.paste_events, 1)

    def test_fewer_than_four_words_leaves_nothing_to_recognise(self):
        measure = m.Measure()
        measure.on_copy(100.0, 'trois mots seulement')
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.paste_events, 1)

    def test_no_text_is_kept_only_numbers(self):
        """The privacy invariant: what is remembered of a copy must not be the text."""
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        kept = [mark for copy in measure.own_text for mark in copy.marks]
        self.assertTrue(kept)
        self.assertTrue(all(isinstance(mark, int) for mark in kept))
        self.assertNotIn('rédaction', repr([copy.marks for copy in measure.own_text]))


class BiggestPasteAndReturnTest(unittest.TestCase):
    """The biggest paste of a window, and what is pasted on returning to the document."""

    def test_every_paste_is_said_with_its_own_size(self):
        # Twenty pastes of a hundred characters and a single one of two thousand give the same
        # total: one run per gesture is what says something arrived in one block.
        measure = m.Measure()
        measure.on_paste(100.0, 'x' * 100)
        measure.on_paste(101.0, 'y' * 2000)
        measure.on_paste(102.0, 'z' * 40)
        window = sealed(measure)
        self.assertEqual(window['runs'], [['paste', 100], ['paste', 2000], ['paste', 40]])
        self.assertEqual(window['sum'], {'keys': 0, 'chars': 2140, 'pastes': 3})

    def test_a_paste_too_short_is_a_paste_and_not_an_injection(self):
        measure = m.Measure()
        measure.on_paste(100.0, 'trois mots ici')
        window = sealed(measure)
        self.assertEqual(window['runs'], [['paste', 14]])
        self.assertEqual(window['sum'], {'keys': 0, 'chars': 0, 'pastes': 1})

    def test_what_is_pasted_right_after_a_return_is_counted_apart(self):
        # Leaving, going to look something up, coming back and pasting is a single gesture.
        measure = m.Measure()
        type_keys(measure, 100.0, 3)
        measure.on_focus_lost()
        measure.on_focus_gained(200.0)
        measure.on_paste(205.0, 'w' * 800)
        self.assertEqual(measure.window.injected_chars, 800)
        self.assertEqual(measure.window.injected_chars_after_return, 800)

    def test_past_the_delay_a_paste_is_a_paste_like_any_other(self):
        measure = m.Measure()
        type_keys(measure, 100.0, 3)
        measure.on_focus_lost()
        measure.on_focus_gained(200.0)
        measure.on_paste(220.0, 'w' * 800)   # past RETURN_WINDOW_S
        self.assertEqual(measure.window.injected_chars_after_return, 0)

    def test_without_having_left_there_is_no_return(self):
        # An activation with no counted departure must not date what follows.
        measure = m.Measure()
        type_keys(measure, 100.0, 3)
        measure.on_focus_gained(200.0)
        measure.on_paste(205.0, 'w' * 800)
        self.assertEqual(measure.window.injected_chars_after_return, 0)

    def test_a_restitution_is_said_for_itself(self):
        # Without its own run, the engine sees a mass revision without being able to tell
        # whether the student rewrote their paragraph by hand or ran it through a corrector —
        # nor how much came back.
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, CORRECTED)
        measure.on_paste(160.0, FOREIGN)
        window = sealed(measure)
        size = len(CORRECTED.replace('\n', ''))
        self.assertEqual(runs_of(window, m.RUN_SELF), [['self', size]])
        self.assertEqual(runs_of(window, m.RUN_PASTE), [['paste', len(FOREIGN.replace('\n', ''))]])
        self.assertEqual(window['sum']['pastes'], 1)


    def test_a_couple_of_words_moved_inside_the_document_is_not_an_injection(self):
        # The four-word floor used to drop short copies: a phrase moved from one sentence to
        # another had left no fingerprint, and came back as someone else's text.
        measure = m.Measure()
        measure.on_copy(100.0, 'developpement durable')
        measure.on_paste(140.0, 'developpement durable')
        self.assertEqual(measure.window.paste_events, 0)
        self.assertEqual(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.timeline[-1], ['self', len('developpement durable')])


class ShingleContractTest(unittest.TestCase):
    """A restitution is only recognised if the four agents hash the same text onto the same
    number. These values are those of the JavaScript suites (browser/tests/sensor.test.mjs,
    word/tests/sensor.test.mjs): pinned on both sides, so that a rewrite on one side shows up
    instead of silencing restitutions on the others."""

    def test_four_words_give_a_known_fingerprint(self):
        self.assertEqual(sorted(m.shingles('Le candidat developpe une')), [1761045176])

    def test_case_accents_and_punctuation_do_not_move_it(self):
        # That is exactly what a corrector changes, and what the normalisation absorbs.
        self.assertEqual(sorted(m.shingles('LE CANDIDAT DÉVELOPPÉ UNE')), [1761045176])
        self.assertEqual(sorted(m.shingles('le, candidat; developpe  une!')), [1761045176])

    def test_the_window_slides_by_one_word(self):
        self.assertEqual(sorted(m.shingles('le candidat developpe une argumentation')),
                         [821320551, 1761045176])

    def test_fewer_than_four_words_are_hashed_whole(self):
        # A couple of words moved inside the document leaves one fingerprint instead of none.
        self.assertEqual(sorted(m.shingles('trois mots seulement')), [1996698289])
        self.assertEqual(sorted(m.shingles('developpement durable')), [4152169010])

    def test_without_a_word_there_is_nothing_to_hash(self):
        self.assertEqual(sorted(m.shingles('!!! ...')), [])

    def test_a_character_outside_the_basic_plane_shifts_nothing(self):
        self.assertEqual(sorted(m.shingles('je rends 😀 ce devoir')), [2526758823])


class RedoTest(unittest.TestCase):
    """Redo is not undo, and Shift is what tells them apart.

    Ctrl/Cmd+Shift+Z puts back what the student had removed: it is the opposite of a correction.
    Counted as one, it inflated `immediate_corrections` for anyone who hesitates out loud — and
    on a Mac, where Cmd+Shift+Z *is* the shortcut for redo, for anyone who uses it. The
    JavaScript equivalent is in browser/tests/sensor.test.mjs.
    """

    def setUp(self):
        self.measure = m.Measure()

    def test_undo_stays_a_correction(self):
        self.measure.on_key(1000.0, m.OTHER, ctrl=True, letter='z')
        self.assertEqual(self.measure.window.corrections, 1)

    def test_redo_adds_none(self):
        self.measure.on_key(1000.0, m.OTHER, ctrl=True, letter='z', shift=True)
        self.assertEqual(self.measure.window.corrections, 0)

    def test_but_redo_settles_the_selection_all_the_same(self):
        # It collapses in both cases: left pending, it would be spent a second time by the next
        # keystroke.
        self.measure.on_key(1000.0, m.OTHER, ctrl=True, letter='a')
        self.measure.on_key(1000.2, m.OTHER, ctrl=True, letter='z', shift=True)
        self.measure.on_key(1000.4, m.OTHER)
        self.assertEqual(self.measure.window.macro_revisions, 0)


class TypingAfterAReturnTest(unittest.TestCase):
    """Leaving the document, reading something and coming back to type it."""

    def setUp(self):
        self.measure = m.Measure()

    def test_typing_just_after_a_return_is_counted_apart(self):
        self.measure.on_focus_lost()
        self.measure.on_focus_gained(1001.0)
        self.measure.on_key(1002.0, m.OTHER)
        window = sealed(self.measure)
        self.assertEqual(window['counts']['back_keys'], 1)
        self.assertEqual(window['counts']['exits'], 1)
        self.assertEqual(keystrokes(window), 1, 'a subset of the keystrokes, never an addition')

    def test_typing_long_after_a_return_is_ordinary_writing(self):
        self.measure.on_focus_lost()
        self.measure.on_focus_gained(1001.0)
        self.measure.on_key(1001.0 + m.RETURN_WINDOW_S + 1, m.OTHER)
        self.assertEqual(sealed(self.measure)['counts']['back_keys'], 0)


class ThePasteKeyPostsAndDoesNotType(unittest.TestCase):
    """Ctrl/Cmd+V and Shift+Insert date what follows and feed the rhythm, but count no keystroke.

    What a paste posts is weighed in `on_paste` — one keystroke for the student's own text coming
    back, none for an injection — and weighed there whatever pasted it: the menu and the toolbar
    have no key to count. Counting the key as well made the same gesture cost two keystrokes from
    the keyboard and one from the menu. Which keys those are is named in `sensor.py`, where the
    office suite's key codes live and where MOD1 is Cmd on macOS; here the category arrives
    already decided, as the office suite hands it over.
    """

    def test_a_restitution_is_one_keystroke_from_the_keyboard(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_key(140.0, m.PASTE, ctrl=True, letter='v')
        measure.on_paste(140.1, CORRECTED)
        self.assertEqual([run[0] for run in measure.window.timeline], ['copy', 'other', 'self'])
        self.assertEqual(measure.window.keystrokes, 1)

    def test_and_exactly_the_same_from_the_menu(self):
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.keystrokes, 1)

    def test_an_injection_is_no_keystroke_at_all(self):
        measure = m.Measure()
        measure.on_key(140.0, m.PASTE, ctrl=True, letter='v')
        measure.on_paste(140.1, FOREIGN)
        self.assertEqual(measure.window.paste_events, 1)
        self.assertGreater(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.keystrokes, 0)
        self.assertTrue(measure.has_activity(), 'the window still has something to send')

    def test_the_paste_key_is_still_activity(self):
        """It opens a window and pushes back its end — but, counting no keystroke, it ends no
        silence: a window holding only that paste would otherwise say a silence between
        keystrokes it does not have. The silence is still said, once and whole, when typing
        resumes."""
        measure = m.Measure()
        measure.on_key(100.0, m.OTHER)
        measure.on_key(104.0, m.PASTE, ctrl=True, letter='v')
        self.assertEqual(measure.window.mono_last, 104.0)
        self.assertEqual(measure.window.timeline, [['type', 1, 0]])
        measure.on_key(105.0, m.OTHER)
        self.assertEqual(measure.window.timeline, [['type', 1, 0], ['gap', 5000], ['type', 1, 0]])

    def test_ctrl_c_stays_an_ordinary_keystroke(self):
        """It puts nothing into the document, so nothing else counts it."""
        measure = m.Measure()
        measure.on_key(100.0, m.OTHER, ctrl=True)
        self.assertEqual(measure.window.keystrokes, 1)


class FlushReasonTest(unittest.TestCase):
    """A window is not a burst of typing: it is a span the agent decided to close.

    The engine cannot tell the triggers apart on its own — a save cutting a burst in two looked,
    on its side, like a writer who never stops — so each agent translates its own triggers into
    the six words the four of them share.
    """

    def test_the_writer_stopping_and_the_counter_stopping_are_not_the_same_word(self):
        self.assertEqual(m.WIRE_FLUSH_REASONS['idle'], 'idle')
        self.assertEqual(m.WIRE_FLUSH_REASONS['volume'], 'volume')

    def test_leaving_the_document_is_an_absence_and_closing_it_ends_the_sitting(self):
        self.assertEqual(m.WIRE_FLUSH_REASONS['blur'], 'away')
        self.assertEqual(m.WIRE_FLUSH_REASONS['pause'], 'end')
        self.assertEqual(m.WIRE_FLUSH_REASONS['pagehide'], 'end')

    def test_a_window_says_the_shared_word_for_the_trigger_that_sealed_it(self):
        measure = m.Measure()
        for trigger, word in (('idle', 'idle'), ('blur', 'away'), ('logout', 'end')):
            measure.on_key(1000, m.OTHER)
            self.assertEqual(sealed(measure, trigger)['why'], word)

    def test_a_trigger_the_table_does_not_know_seals_nothing(self):
        """The word is mandatory, so there is no sending a window without one: the mistake is
        heard where it is made, and the window stays open for a trigger that can say why."""
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        with self.assertRaises(KeyError):
            measure.take('something-new')
        self.assertEqual(sealed(measure)['seq'], 0)

    def test_nothing_outside_the_shared_vocabulary_is_ever_sent(self):
        self.assertTrue(set(m.WIRE_FLUSH_REASONS.values())
                        <= {'idle', 'volume', 'save', 'focus', 'away', 'end'})


# --- the window as it is sent -----------------------------------------------------------------
#
# `check_relations` is the shape of a window and every relation the engine checks inside one,
# asserted here on scripted sessions. What the engine works out from the runs — keystrokes,
# pastes, injected characters — is worked out the same way below, and compared to the totals
# the sensor keeps for the session: they agree because both are fed by the function that
# counts, not because a second classifier happens to reach the same numbers.

WINDOW_KEYS = ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'flight', 'dwell', 'text', 'sum']
OPTIONAL_KEYS = {'flight', 'text'}      # `dwell` is not: this sensor sees keys come back up
COUNT_KEYS = ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars']
INSTANT_RUNS = (m.RUN_CLICK, m.RUN_PASTE, m.RUN_SELF, m.RUN_COPY, m.RUN_UNDO)


class Clock:
    """A clock the test moves by hand. The scripts below give the measure their instants as the
    sensor does, on the monotonic clock, and this one stands for the wall clock beside it —
    kept on the same instant unless a test says the hour was changed."""

    def __init__(self, at=1000.0):
        self.at = at

    def __call__(self):
        return self.at


def whole(test, value, least=0):
    test.assertIs(type(value), int)
    test.assertGreaterEqual(value, least)


def derived(window):
    """What the engine reads in the runs of one window: (keystrokes, injected characters,
    pastes) — the three numbers the session's totals are made of."""
    pastes = [run[1] for run in runs_of(window, m.RUN_PASTE)]
    return (keystrokes(window), sum(n for n in pastes if n > m.INJECTION_MIN_CHARS), len(pastes))


def check_relations(test, sealed_window):
    session, window = sealed_window
    test.assertRegex(session, r'^[A-Za-z0-9_-]{16,64}$')
    test.assertEqual(list(window), [key for key in WINDOW_KEYS if key in window])
    test.assertEqual(set(WINDOW_KEYS) - set(window) - OPTIONAL_KEYS, set())
    for key in ('seq', 'at', 'mono', 'active'):
        whole(test, window[key])
    whole(test, window['ms'], 1000)
    test.assertIn(window['why'], {'idle', 'volume', 'save', 'focus', 'away', 'end'})

    runs = window['runs']
    test.assertTrue(runs, 'a sealed window carries an activity')
    test.assertLessEqual(len(runs), m.TIMELINE_MAX_RUNS)
    for run in runs:
        # Three shapes, by kind: keystrokes over a duration, a gesture and its quantity, a
        # silence and its length.
        if run[0] in KEYSTROKE_RUNS:
            test.assertEqual(len(run), 3)
        elif run[0] == m.RUN_GAP:
            test.assertEqual(len(run), 2)
            test.assertGreaterEqual(run[1], m.GAP_MIN_MS)
        else:
            test.assertIn(run[0], INSTANT_RUNS)
            test.assertEqual(len(run), 2)
        for value in run[1:]:
            whole(test, value)
    for before, after in zip(runs, runs[1:]):
        if before[0] == after[0]:
            test.assertIn(before[0], m.SINGLE_RUNS, 'two consecutive runs of one kind')

    # Everything but the silence that led up to the window fits in what the window lasted.
    counted = runs[1:] if runs[0][0] == m.RUN_GAP else runs
    lasted = sum(run[2] for run in counted if run[0] in KEYSTROKE_RUNS) + sum(gaps({'runs': counted}))
    test.assertLessEqual(lasted, window['ms'] + 1000)

    test.assertEqual(list(window['counts']), COUNT_KEYS)
    for value in window['counts'].values():
        whole(test, value)
    typed = sum(run[1] for run in runs_of(window, m.RUN_TYPE))
    test.assertLessEqual(window['counts']['back_keys'], keystrokes(window))

    for block, bands in (('flight', m.FLIGHT_BINS_MS), ('dwell', m.DWELL_BINS_MS)):
        if block in window:
            bins = window[block]['bins']
            test.assertLessEqual(len(bins), len(bands))
            test.assertTrue(not bins or bins[-1] > 0, 'trailing zeros are not sent')
    if 'flight' in window:
        flight = window['flight']
        test.assertEqual(list(flight), ['med', 'mad', 'bins'])
        test.assertGreaterEqual(sum(flight['bins']), 2)
        # The median falls in the bands its two middle values fall in.
        edges = [*m.FLIGHT_BINS_MS, m.FLIGHT_MAX_MS]
        spread = [index for index, n in enumerate(flight['bins']) for _ in range(n)]
        low, high = spread[(len(spread) - 1) // 2], spread[len(spread) // 2]
        test.assertTrue(edges[low] <= flight['med'] <= edges[high + 1])
    dwell = window['dwell']
    test.assertEqual(list(dwell), ['bins', 'rollover'])
    test.assertLessEqual(sum(dwell['bins']), typed)
    test.assertLessEqual(dwell['rollover'], sum(dwell['bins']))

    if 'text' in window:
        text = window['text']
        test.assertIn(list(text), (['len'], ['len', 'since', 'at', 'cut', 'add'],
                                   ['len', 'since', 'at', 'cut', 'add', 'kept']))
        if 'since' in text:
            test.assertLess(text['since'], window['seq'])
            test.assertLessEqual(text['at'] + text['add'], text['len'])
            test.assertLessEqual(text.get('kept', 0), min(text['cut'], text['add']))

    # Each total is at least what the window itself holds, and exactly that for the first one.
    test.assertEqual(list(window['sum']), ['keys', 'chars', 'pastes'])
    for total, own in zip(window['sum'].values(), derived(window)):
        test.assertGreaterEqual(total, own)
        if window['seq'] == 0:
            test.assertEqual(total, own)
    return window


class TimelineTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.measure = m.Measure(monotonic=self.clock, wall=self.clock)

    def at(self, now):
        """Moves the wall clock to the instant the script is at."""
        self.clock.at = now
        return now

    def type_keys(self, start, count, interval=0.15, category=m.OTHER):
        now = start
        for _ in range(count):
            self.measure.on_key(self.at(now), category)
            now += interval
        return now

    def test_a_session_of_everything_keeps_every_relation(self):
        """Typing, a silence, moving, erasing, an outside paste, the student's own text coming
        back, an undo and a click — over three windows of one session."""
        measure = self.measure
        own = 'Le développement durable repose sur trois piliers indissociables.'

        now = self.type_keys(1000, 20, 0.25)                           # 20 keys
        now = self.type_keys(now + 5, 3, 0.25, category=m.NAVIGATION)  # a silence, then arrows
        now = self.type_keys(now, 6, 0.25)
        now = self.type_keys(now, 7, 0.125, category=m.ERASE)
        now = self.type_keys(now + 1.5, 5, 0.25)                       # a shorter silence
        measure.on_paste(self.at(now), 'x' * 240)
        first = check_relations(self, measure.take(volume=300))
        self.assertEqual(first['runs'], [
            ['type', 20, 4750], ['gap', 5250], ['nav', 3, 500], ['type', 6, 1250],
            ['erase', 7, 750], ['gap', 1625], ['type', 5, 1000], ['paste', 240]])
        self.assertEqual((first['at'], first['mono'], first['ms']), (1000000, 0, 15875))
        self.assertEqual(first['text'], {'len': 300})

        measure.on_copy(self.at(1500), own)
        measure.on_key(self.at(1500), m.OTHER, ctrl=True)              # the Ctrl+C itself
        measure.on_paste(self.at(1501.5), own)                         # back from the corrector
        measure.on_key(self.at(1502), m.OTHER, ctrl=True, letter='z')
        second = check_relations(self, measure.take())
        # The silence that led up to the window leads its timeline, at its real length — eight
        # minutes, which nothing caps. The block pasted back is a keystroke no key made: it
        # counts in the run and does not stretch it, and the silence between the two shortcuts
        # sits where it began — after the key that preceded it.
        self.assertEqual(second['runs'], [
            ['gap', 484375], ['copy', len(own)], ['other', 2, 0], ['gap', 2000], ['self', len(own)],
            ['other', 1, 0], ['undo', 1]])
        self.assertEqual((second['at'], second['mono'], second['ms']), (1500000, 500000, 2000))
        self.assertNotIn('text', second)                   # no count of the document was read

        measure.on_click(self.at(1600))
        measure.on_click(self.at(1600.5))
        self.type_keys(1601, 4, 0.25)
        third = check_relations(self, measure.take())
        # The silence leads, the clicks follow.
        self.assertEqual(third['runs'], [['gap', 99000], ['click', 2], ['type', 4, 750]])

        # One session, numbered from zero, with totals that run up to each window included —
        # and that are what the engine adds up from the runs of the three.
        windows = [first, second, third]
        self.assertEqual([window['seq'] for window in windows], [0, 1, 2])
        self.assertEqual(first['sum'], {'keys': 41, 'chars': 240, 'pastes': 1})
        self.assertEqual(second['sum'], {'keys': 44, 'chars': 240, 'pastes': 1})
        self.assertEqual(third['sum'], {'keys': 48, 'chars': 240, 'pastes': 1})
        self.assertEqual(tuple(third['sum'].values()),
                         tuple(sum(column) for column in zip(*(derived(window) for window in windows))))

    def test_a_window_of_pastes_only(self):
        """No keystroke at all: three runs, one per gesture, and the small one is a paste that
        injects nothing. No flight times — and a dwell block all the same, saying no key was
        timed."""
        for offset, size in enumerate((40, 10, 300)):
            self.measure.on_paste(self.at(1000 + offset), 'x' * size)
        window = check_relations(self, self.measure.take())
        self.assertEqual(window['runs'], [['paste', 40], ['paste', 10], ['paste', 300]])
        self.assertEqual(window['sum'], {'keys': 0, 'chars': 340, 'pastes': 3})
        self.assertNotIn('flight', window)
        self.assertEqual(window['dwell'], {'bins': [], 'rollover': 0})

    def test_a_silence_ended_by_a_click_then_typing_leads_the_window(self):
        """The click opens the window, the keystroke after it ends the silence: the silence
        began before the window did, so it leads the timeline and is not counted in what the
        window lasted — and the click, which is not a keystroke, ended no silence."""
        self.type_keys(1000, 3, 0.25)
        self.measure.take()
        self.measure.on_click(self.at(1010))
        self.type_keys(1011, 3, 0.25)
        window = check_relations(self, self.measure.take())
        self.assertEqual(window['runs'], [['gap', 10500], ['click', 1], ['type', 3, 500]])
        self.assertEqual(window['ms'], 1500)

    def test_clicks_inside_a_silence_do_not_say_its_time_twice(self):
        """Two clicks while thinking, then typing: the silence runs from keystroke to keystroke
        over both clicks, and is put where it began. A click run has a number, never a
        duration: the silence already covers that time."""
        self.type_keys(1000, 2, 0.25)
        self.measure.on_click(self.at(1002))
        self.measure.on_click(self.at(1008))
        self.type_keys(1010, 2, 0.25)
        window = check_relations(self, self.measure.take())
        self.assertEqual(window['runs'], [['type', 2, 250], ['gap', 9750], ['click', 2], ['type', 2, 250]])
        self.assertEqual(window['counts']['jumps'], 2)

    def test_the_keystroke_ceiling_seals_a_window_whose_runs_add_up(self):
        reasons = []
        now = 1000
        for index in range(m.FLUSH_KEYSTROKES):
            category = (m.OTHER, m.OTHER, m.OTHER, m.ERASE, m.NAVIGATION)[index % 5]
            reasons.append(self.measure.on_key(self.at(now), category))
            now += 0.125
        self.assertEqual(reasons[-1], 'volume')
        self.assertEqual(set(reasons[:-1]), {None})
        window = check_relations(self, self.measure.take('volume'))
        self.assertEqual(window['why'], 'volume')
        self.assertEqual(keystrokes(window), m.FLUSH_KEYSTROKES)
        self.assertEqual(sum(window['flight']['bins']), m.FLUSH_KEYSTROKES - 1)

    def test_a_run_never_breaks_on_what_was_typed(self):
        """The measure is told a category, never a character: letters, spaces, punctuation and
        Enter all arrive as the same thing and make one run, so no word length can be read in
        it. Ctrl makes a shortcut of a key — unless Alt is down too, which is AltGr typing a
        character on Windows."""
        self.type_keys(1000, 30, 0.125)
        self.measure.on_key(self.at(1003.75), m.OTHER, ctrl=True, altgr=True)
        self.measure.on_key(self.at(1003.875), m.OTHER, shift=True)
        self.measure.on_key(self.at(1004), m.OTHER, ctrl=True)
        window = check_relations(self, self.measure.take())
        self.assertEqual(window['runs'], [['type', 32, 3875], ['other', 1, 0]])

    def test_clicks_alone_carry_over_into_the_next_window(self):
        self.measure.on_click(self.at(1000))
        self.measure.on_click(self.at(1001.5))
        self.assertIsNone(self.measure.take())
        self.measure.on_click(self.at(1100))
        self.measure.on_click(self.at(1100.5))
        self.type_keys(1101, 2, 0.25)
        window = check_relations(self, self.measure.take())
        self.assertEqual(window['runs'], [['click', 4], ['type', 2, 250]])
        self.assertEqual(window['counts']['jumps'], 4)
        self.assertEqual(window['seq'], 0)   # the window that sent nothing was not sealed

    def test_a_timeline_about_to_overflow_seals_the_window(self):
        """Pastes are one run each and are never merged: a window of nothing else would grow
        past what the engine accepts. It is sealed before, with every run still in it."""
        reasons = []
        for index in range(m.TIMELINE_MAX_RUNS):
            reasons.append(self.measure.on_paste(self.at(1000 + index), 'x' * 20))
            if reasons[-1]:
                break
        self.assertEqual(len(reasons), m.TIMELINE_MAX_RUNS - m.TIMELINE_HEADROOM)
        window = check_relations(self, self.measure.take('volume'))
        self.assertEqual(len(window['runs']), m.TIMELINE_MAX_RUNS - m.TIMELINE_HEADROOM)

    def test_a_timeline_is_never_sent_short_of_a_run(self):
        """Clicks and copies alone are not worth a window — until their runs are about to
        reach the ceiling. No run is dropped to make room: the window is sealed as it is, with
        no keystroke in it, by whichever of the two gestures filled it."""
        reasons = []
        for index in range(m.TIMELINE_MAX_RUNS):
            now = self.at(1000 + index)
            reasons.append(self.measure.on_click(now) if index % 2 else self.measure.on_copy(now, 'un mot'))
            if reasons[-1]:
                break
            if index == 100:
                self.assertIsNone(self.measure.take())      # an idle delay passing over it
        self.assertEqual(reasons[-1], 'volume')
        window = check_relations(self, self.measure.take('volume'))
        self.assertEqual(len(window['runs']), m.TIMELINE_MAX_RUNS - m.TIMELINE_HEADROOM)
        self.assertEqual({run[0] for run in window['runs']}, {'click', 'copy'})
        self.assertEqual(window['sum'], {'keys': 0, 'chars': 0, 'pastes': 0})
        self.assertEqual(self.measure.window.timeline, [])

    def test_the_monotonic_clock_starts_at_the_session(self):
        self.measure.start_session()         # the document was opened at 1000 on that clock
        self.type_keys(1002, 5, 0.5)
        window = check_relations(self, self.measure.take())
        self.assertEqual((window['at'], window['mono'], window['ms']), (1002000, 2000, 2000))
        self.measure.on_key(self.at(1010), m.OTHER)
        window = check_relations(self, self.measure.take())
        self.assertEqual((window['mono'], window['ms']), (10000, 1000))   # one instant: a second

    def test_no_duration_is_read_on_the_wall_clock(self):
        """`at` is the wall clock and nothing else is: an hour set back between two keystrokes
        moves neither the length of the window, nor its effective time, nor a run, nor a
        silence, nor a flight time."""
        self.type_keys(1000, 3, 0.25)
        self.clock.at -= 3600                       # the hour is set back; the script goes on
        self.measure.on_key(1000.75, m.OTHER)
        self.measure.on_key(1003, m.OTHER)
        self.measure.on_key(1003.25, m.OTHER)
        window = check_relations(self, self.measure.take())
        self.assertEqual((window['at'], window['mono'], window['ms']), (1000000, 0, 3250))
        self.assertEqual(window['runs'], [['type', 4, 750], ['gap', 2250], ['type', 2, 250]])
        self.assertEqual(window['active'], 1250)    # four gaps of 250 ms, and the flat 250
        self.assertEqual(window['flight'], {'med': 250, 'mad': 0, 'bins': [0, 0, 0, 0, 0, 0, 0, 0, 0, 4]})


class SessionTest(unittest.TestCase):
    def test_a_session_is_named_at_random_and_numbers_from_zero(self):
        measure = m.Measure()
        measure.start_session()
        first = measure.session
        self.assertRegex(first, r'^[A-Za-z0-9_-]{16,64}$')
        self.assertGreaterEqual(m.SESSION_ID_BYTES, 12)    # 96 bits at the least
        type_keys(measure, 1000, 3)
        session, window = measure.take()
        self.assertEqual((session, window['seq']), (first, 0))
        type_keys(measure, 1010, 3)
        session, window = measure.take()
        self.assertEqual((session, window['seq']), (first, 1))

        measure.end_session()
        type_keys(measure, 1020, 3)     # measuring again: a new session, opened by what is counted
        session, window = measure.take()
        self.assertNotEqual(session, first)
        self.assertEqual(window['seq'], 0)
        self.assertEqual(window['mono'], 0)             # and its clock starts with it
        self.assertEqual(window['sum']['keys'], 3)
        # A silence never crosses a session: the ten seconds since the last keystroke of the
        # one before are not said at the head of this one.
        self.assertEqual([run[0] for run in window['runs']], ['type'])

    def test_a_silence_is_measured_inside_the_session_from_its_second_keystroke_on(self):
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        measure.take('pause')
        measure.end_session()
        measure.on_key(1100, m.OTHER)                   # the first of a new session: no silence
        measure.on_key(1102, m.OTHER)                   # the second: two seconds after the first
        self.assertEqual(sealed(measure)['runs'], [['type', 1, 0], ['gap', 2000], ['type', 1, 0]])

    def test_a_window_sealed_and_never_sent_is_still_counted(self):
        """Numbering belongs to sealing: whoever calls take() and throws the window away has
        still moved the number and the totals, which is how the next one shows it missing."""
        measure = m.Measure()
        type_keys(measure, 1000, 4)
        measure.take()                  # sealed, and dropped by the caller
        type_keys(measure, 1010, 2)
        window = sealed(measure)
        self.assertEqual(window['seq'], 1)
        self.assertEqual(window['sum']['keys'], 6)


class RhythmTest(unittest.TestCase):
    def test_the_bands_are_the_engine_s(self):
        self.assertEqual(m.FLIGHT_BINS_MS, (0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650))
        self.assertEqual(m.DWELL_BINS_MS, (0, 20, 40, 60, 80, 100, 120, 150, 200, 300))
        self.assertEqual(m.TIMELINE_MAX_RUNS, 512)

    def test_a_value_on_an_edge_opens_its_band(self):
        counts = m.histogram([0, 19.9, 20, 129.99, 130, 649, 650, 799.9], m.FLIGHT_BINS_MS)
        self.assertEqual(counts, [2, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 2])

    def test_a_histogram_leaves_without_its_trailing_zeros(self):
        self.assertEqual(m.trimmed([0, 2, 9, 0, 0]), [0, 2, 9])
        self.assertEqual(m.trimmed([0, 2, 0, 9]), [0, 2, 0, 9])
        self.assertEqual(m.trimmed([0, 0, 0]), [])
        self.assertEqual(m.trimmed([]), [])

    def test_flights_leave_as_a_distribution_under_the_median_s_condition(self):
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        measure.on_key(1000.125, m.OTHER)
        self.assertNotIn('flight', sealed(measure))       # one gap: no median, no histogram
        measure.on_key(1010, m.OTHER)
        measure.on_key(1010.125, m.OTHER)
        measure.on_key(1010.375, m.OTHER)
        self.assertEqual(sealed(measure)['flight'],
                         {'med': 187.5, 'mad': 62.5, 'bins': [0, 0, 0, 0, 0, 1, 0, 0, 0, 1]})

    def test_a_release_is_timed_in_the_window_that_counted_its_press(self):
        measure = m.Measure()
        measure.on_key(1000, m.OTHER)
        measure.on_release(measure.last_typed, 95.0, False)
        measure.on_key(1000.25, m.OTHER)
        measure.on_release(measure.last_typed, 310.0, True)
        measure.on_key(1000.5, m.ERASE)
        self.assertIsNone(measure.last_typed)             # only a key that types is timed
        measure.on_key(1000.75, m.OTHER)
        late = measure.last_typed
        self.assertEqual(sealed(measure)['dwell'], {'bins': [0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'rollover': 1})

        # The third key comes up after its window was sealed: it is timed nowhere, so the next
        # window never holds more dwell times than keys it typed. The block is sent all the
        # same, with nothing in it: this sensor sees releases, and saw none.
        measure.on_key(1010, m.NAVIGATION)
        measure.on_paste(1010.5, 'x' * 30)
        measure.on_release(late, 80.0, True)
        self.assertEqual(sealed(measure)['dwell'], {'bins': [], 'rollover': 0})


class TextSpanTest(unittest.TestCase):
    def test_where_two_readings_differ(self):
        cases = [
            ('', '', (0, 0, 0)),
            ('abc', 'abc', (3, 0, 0)),
            ('abc', 'abcdef', (3, 0, 3)),                 # written at the end
            ('abcdef', 'abXYZdef', (2, 1, 3)),            # inside what was already written
            ('abcdef', 'abXYef', (2, 2, 2)),              # replaced by as much: the size did not move
            ('abcdef', 'af', (1, 4, 0)),
            ('aaa', 'aa', (2, 1, 0)),                     # prefix and suffix never overlap
            ('aa', 'aaa', (2, 0, 1)),
            ('abc', 'xyz', (0, 3, 3)),
            ('', 'abc', (0, 0, 3)),
        ]
        for before, after, expected in cases:
            with self.subTest(before=before, after=after):
                at, cut, add = m.text_span(before, after)
                self.assertEqual((at, cut, add), expected)
                self.assertEqual(len(after), len(before) - cut + add)
                self.assertLessEqual(at + cut, len(before))

    def test_a_long_text_is_compared_exactly(self):
        before = 'mot ' * 50000
        after = before[:120001] + 'inséré' + before[120003:]
        self.assertEqual(m.text_span(before, after), (120001, 2, 6))

    def test_what_a_span_kept_is_counted_by_words(self):
        """Two places touched between two readings give one span from the first to the last:
        the passage left intact between them is in what was cut and in what was added alike,
        and `kept` is what says it is not new."""
        middle = 'le développement durable repose sur trois piliers '
        before = 'Début. Ancien ' + middle + 'vieux. Fin.'
        after = 'Début. Nouveau ' + middle + 'neuf et plus. Fin.'
        at, cut, add = m.text_span(before, after)
        kept = m.text_kept(before[at:at + cut], after[at:at + add])
        self.assertEqual(kept, len(middle))
        self.assertLessEqual(kept, min(cut, add))
        # A paragraph replaced by another of the same size kept nothing: all of it is new.
        self.assertEqual(m.text_kept('un texte écrit ici', 'des mots tout autres'), 0)
        self.assertEqual(m.text_kept('', 'ajout'), 0)
        self.assertEqual(m.text_kept('retrait', ''), 0)

    def test_what_a_span_kept_is_not_computed_past_its_bound(self):
        long = 'mot ' * (m.TEXT_KEPT_MAX_WORDS + 1)
        self.assertIsNone(m.text_kept(long, 'mot '))
        self.assertIsNone(m.text_kept('mot ', long))
        self.assertEqual(m.text_kept('mot ' * m.TEXT_KEPT_MAX_WORDS, 'mot '), 4)
        # Nor when the comparison itself would cost too much: one word, repeated on both sides.
        self.assertIsNone(m.text_kept('mot ' * 200, 'mot ' * 200))
        self.assertEqual(m.text_kept('mot ' * 150, 'mot ' * 150), 600)
        measure = m.Measure()
        type_keys(measure, 1000, 3)
        measure.take(volume=len(long) + 2, text='a ' + long)
        type_keys(measure, 1010, 3)
        text = sealed(measure, volume=len(long) + 2, text='b ' + long[:-2] + 'c ')['text']
        self.assertEqual(list(text), ['len', 'since', 'at', 'cut', 'add'])   # left out, never guessed
        self.assertGreater(text['cut'], 8000)

    def test_the_span_is_said_from_the_second_reading_on(self):
        measure = m.Measure()
        type_keys(measure, 1000, 3)
        # Nothing to compare the first reading to: the size, alone.
        self.assertEqual(sealed(measure, volume=12, text='Introduction')['text'], {'len': 12})

        type_keys(measure, 1010, 3)
        self.assertEqual(sealed(measure, volume=12)['text'], {'len': 12})   # the count came from the cache

        type_keys(measure, 1020, 3)
        text = sealed(measure, volume=15, text='Introduction du')['text']
        self.assertEqual(text, {'len': 15, 'since': 0, 'at': 12, 'cut': 0, 'add': 3, 'kept': 0})
        self.assertEqual(list(text), ['len', 'since', 'at', 'cut', 'add', 'kept'])
        self.assertEqual(text['len'], 12 - text['cut'] + text['add'])

        # A reading identical to the one before it is still a reading: a span of nothing.
        type_keys(measure, 1030, 3)
        self.assertEqual(sealed(measure, volume=15, text='Introduction du')['text'],
                         {'len': 15, 'since': 2, 'at': 15, 'cut': 0, 'add': 0, 'kept': 0})

    def test_a_count_that_could_not_be_read_sends_no_text(self):
        measure = m.Measure()
        type_keys(measure, 1000, 3)
        self.assertNotIn('text', sealed(measure))
        type_keys(measure, 1010, 3)
        self.assertNotIn('text', sealed(measure, text='Introduction'))     # a text and no count

    def test_a_reading_that_is_not_the_size_sent_says_the_size_alone(self):
        """Writer's count takes in what the body text does not hold. A span is only said of a
        reading that is exactly the size beside it, so the two cannot disagree: the count goes
        alone — and the reading before it stays the one the next span is measured from."""
        measure = m.Measure()
        type_keys(measure, 1000, 3)
        measure.take(volume=5, text='Titre')
        type_keys(measure, 1010, 3)
        self.assertEqual(sealed(measure, volume=40, text='Titre et')['text'], {'len': 40})
        type_keys(measure, 1020, 3)
        self.assertEqual(sealed(measure, volume=10, text='Titre et 1')['text'],
                         {'len': 10, 'since': 0, 'at': 5, 'cut': 0, 'add': 5, 'kept': 0})

    def test_the_previous_reading_goes_with_the_session(self):
        measure = m.Measure()
        type_keys(measure, 1000, 3)
        measure.take(volume=5, text='Titre')
        self.assertEqual(measure.previous_text, 'Titre')
        measure.end_session()
        self.assertIsNone(measure.previous_text)
        type_keys(measure, 1010, 3)
        # A new session has no reading before it.
        self.assertEqual(sealed(measure, volume=8, text='Titre et')['text'], {'len': 8})
