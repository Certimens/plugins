"""Definitions of measure.py (the same as browser/content.js)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

from certimens_agent import measure as m


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
        self.assertEqual(values['keystrokes_total'], 10)
        self.assertEqual(values['flight_median_ms'], 200)
        self.assertEqual(values['flight_mad_ms'], 0)
        self.assertEqual(values['effective_time_ms'], 1800)  # 9 gaps of 200 ms
        self.assertEqual(values['real_volume_chars'], 42)
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
        self.assertEqual(values['injected_chars_total'], len('un long texte collésur deux lignes'))

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
        self.assertNotIn('flight_mad_ms', values)
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

    def test_a_bare_modifier_is_not_a_keystroke(self):
        """Shift, Ctrl or Alt pressed on its own writes nothing.

        Counting one inflated keystrokes_total for everyone who types capitals, and its
        near-zero gap before the character it modifies passed for an impossibly fast one —
        exactly what flight_mad_ms and flight_median_ms exist to tell apart. Word and VS Code, which
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
        """Shift pressed between a click and a Backspace: still a mass revision."""
        measure = m.Measure()
        measure.on_click(0.0)
        measure.on_key(0.2, m.MODIFIER)
        measure.on_key(0.4, m.ERASE)
        self.assertEqual(measure.window.macro_revisions, 1)
        self.assertEqual(measure.window.corrections, 0)

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

    def test_the_biggest_paste_is_kept_not_the_last(self):
        # Twenty pastes of a hundred characters and a single one of two thousand give the same
        # total: this counter is the only one saying something arrived in one block.
        measure = m.Measure()
        measure.on_paste(100.0, 'x' * 100)
        measure.on_paste(101.0, 'y' * 2000)
        measure.on_paste(102.0, 'z' * 40)
        self.assertEqual(measure.window.injected_chars, 2140)
        self.assertEqual(measure.window.injected_chars_max, 2000)

    def test_a_paste_too_short_counts_nowhere(self):
        measure = m.Measure()
        measure.on_paste(100.0, 'trois mots ici')
        self.assertEqual(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.injected_chars_max, 0)

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

    def test_a_restitution_is_counted_for_itself(self):
        # Without this counter, the engine sees a mass revision without being able to tell
        # whether the student rewrote their paragraph by hand or ran it through a corrector.
        measure = m.Measure()
        measure.on_copy(100.0, WRITTEN)
        measure.on_paste(140.0, CORRECTED)
        self.assertEqual(measure.window.self_paste_events, 1)
        measure.on_paste(160.0, FOREIGN)
        self.assertEqual(measure.window.self_paste_events, 1)
        self.assertEqual(measure.window.paste_events, 1)


    def test_a_couple_of_words_moved_inside_the_document_is_not_an_injection(self):
        # The four-word floor used to drop short copies: a phrase moved from one sentence to
        # another had left no fingerprint, and came back as someone else's text.
        measure = m.Measure()
        measure.on_copy(100.0, 'developpement durable')
        measure.on_paste(140.0, 'developpement durable')
        self.assertEqual(measure.window.paste_events, 0)
        self.assertEqual(measure.window.injected_chars, 0)
        self.assertEqual(measure.window.self_paste_events, 1)


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


class TheCountersAddedForTheVectorsTheModelCouldNotSee(unittest.TestCase):
    """A word being searched for, the volume of a restitution, and typing after a return.

    The first is the proof of life the rest of the model lacks: someone retyping a finished text
    pauses and corrects like anyone else, but does not hesitate over a word already chosen and
    sitting on the screen in front of them.
    """

    def setUp(self):
        self.measure = m.Measure()

    def test_a_silence_of_one_to_three_seconds_is_a_word_search(self):
        self.measure.on_key(1000.0, m.OTHER)
        self.measure.on_key(1001.6, m.OTHER)
        self.assertEqual(self.measure.window.hesitations, 1)
        self.assertEqual(self.measure.window.pauses, 0, 'not counted twice as a cognitive pause')

    def test_a_fluent_keystroke_is_not_one(self):
        self.measure.on_key(1000.0, m.OTHER)
        self.measure.on_key(1000.2, m.OTHER)
        self.assertEqual(self.measure.window.hesitations, 0)

    def test_a_real_pause_stays_a_pause(self):
        # The band exists because neither neighbouring rule covers it: under 800 ms it is a
        # flight time, past 3 s it is a cognitive pause.
        self.measure.on_key(1000.0, m.OTHER)
        self.measure.on_key(1004.0, m.OTHER)
        self.assertEqual(self.measure.window.hesitations, 0)
        self.assertEqual(self.measure.window.pauses, 1)

    def test_typing_just_after_a_return_is_counted_apart(self):
        self.measure.on_focus_lost()
        self.measure.on_focus_gained(1001.0)
        self.measure.on_key(1002.0, m.OTHER)
        self.assertEqual(self.measure.window.keystrokes_after_return, 1)
        self.assertEqual(self.measure.window.keystrokes, 1,
                         'a subset of the keystrokes, never an addition')

    def test_typing_long_after_a_return_is_ordinary_writing(self):
        self.measure.on_focus_lost()
        self.measure.on_focus_gained(1001.0)
        self.measure.on_key(1001.0 + m.RETURN_WINDOW_S + 1, m.OTHER)
        self.assertEqual(self.measure.window.keystrokes_after_return, 0)


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
        self.assertEqual(measure.window.self_paste_events, 1)
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
        """It opens a window and dates what follows: the silence before a paste is a real one."""
        measure = m.Measure()
        measure.on_key(100.0, m.OTHER)
        measure.on_key(104.0, m.PASTE, ctrl=True, letter='v')
        self.assertEqual(measure.window.pauses, 1)

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

    def test_a_trigger_the_table_does_not_know_says_nothing(self):
        """The safe failure: the engine reads nothing as "the agent did not say"."""
        self.assertIsNone(m.WIRE_FLUSH_REASONS.get('something-new'))

    def test_nothing_outside_the_shared_vocabulary_is_ever_sent(self):
        self.assertTrue(set(m.WIRE_FLUSH_REASONS.values())
                        <= {'idle', 'volume', 'save', 'focus', 'away', 'end'})
