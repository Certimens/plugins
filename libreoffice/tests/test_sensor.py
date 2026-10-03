"""What sensor.py adds between LibreOffice's events and measure.py, without LibreOffice.

sensor.py is UNO glue and most of it only means something inside the office suite: the views,
the interceptors, the info bar. Three things in it are rules and not wiring, though, and they
are held here against doubles of `uno` — which key releases are timed, when a session starts
over, and which reading of the text a window carries. The doubles answer what the sensor asks
and nothing more; what a real Writer answers is `make test-host`'s to say, and TESTING.md's.
"""

import os
import shutil
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'pythonpath'))

# The modifier flags are bits the sensor masks; every other constant only has to be distinct.
CONSTANTS = {'com.sun.star.awt.KeyModifier.SHIFT': 1, 'com.sun.star.awt.KeyModifier.MOD1': 2,
             'com.sun.star.awt.KeyModifier.MOD2': 4}


def _install_uno_doubles():
    """Puts just enough of `uno` in sys.modules for sensor.py to be imported."""
    if 'uno' in sys.modules:
        return
    uno = types.ModuleType('uno')
    uno.getConstantByName = lambda name: CONSTANTS.setdefault(name, 1000 + len(CONSTANTS))
    unohelper = types.ModuleType('unohelper')
    unohelper.Base = type('Base', (), {})
    sys.modules.update(uno=uno, unohelper=unohelper)
    interfaces = {
        'com.sun.star.awt': ('XKeyHandler', 'XMouseClickHandler', 'XTopWindowListener'),
        'com.sun.star.beans': ('StringPair',),
        'com.sun.star.document': ('XDocumentEventListener',),
        'com.sun.star.frame': ('XDispatch', 'XDispatchProviderInterceptor'),
    }
    for path in ('com', 'com.sun', 'com.sun.star', *interfaces):
        sys.modules[path] = types.ModuleType(path)
    for path, names in interfaces.items():
        for name in names:
            setattr(sys.modules[path], name, type(name, (), {}))


_install_uno_doubles()

from certimens_agent import measure as m  # noqa: E402 — after the doubles, which it needs
from certimens_agent import sensor as sensor_module  # noqa: E402
from certimens_agent.engine import Engine  # noqa: E402

KEY_A = sensor_module._key('A')
KEY_B = sensor_module._key('B')
KEY_C = sensor_module._key('C')
BACKSPACE = sensor_module._key('BACKSPACE')


class Properties:
    def __init__(self):
        self.values = {}

    def getPropertySetInfo(self):
        return types.SimpleNamespace(hasPropertyByName=lambda name: name in self.values)

    def getPropertyValue(self, name):
        return self.values[name]

    def setPropertyValue(self, name, value):
        self.values[name] = value

    def addProperty(self, name, flags, value):
        self.values[name] = value


class Document:
    """A Writer document as the sensor reads it: its properties, its count, its body text."""

    def __init__(self, text=''):
        self.text = text
        self.count = None   # Writer's own count, when it is not simply the body's
        self.reads = 0
        self.properties = Properties()

    def getDocumentProperties(self):
        return types.SimpleNamespace(getUserDefinedProperties=lambda: self.properties)

    def addDocumentEventListener(self, listener):
        pass

    def getURL(self):
        return ''

    def getTitle(self):
        return 'Sans nom 1'

    def getPropertyValue(self, name):
        if name != 'CharacterCount':
            raise KeyError(name)
        return len(self.text.replace('\r', '').replace('\n', '')) if self.count is None else self.count

    def getText(self):
        def read():
            self.reads += 1
            return self.text
        return types.SimpleNamespace(getString=read)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    # One instant for both clocks: a test that sets the hour sets how long things lasted too.
    monotonic = time


def key(code, modifiers=0, char='a'):
    return types.SimpleNamespace(KeyCode=code, Modifiers=modifiers, KeyChar=char)


class SensorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.engine = Engine(os.path.join(self.dir, 'certimens.json'))
        self.engine.state['config'] = {'token': 'api1', 'email': 'a@b.fr'}
        self.clock = Clock()
        self.real_time = sensor_module.time
        sensor_module.time = self.clock
        self.doc = Document('Introduction')
        self.sensor = sensor_module.DocumentSensor(None, self.engine, self.doc)
        self.sensor.measure.monotonic = self.clock.monotonic
        self.sensor.measure.wall = self.clock.time
        self.sensor.measure.start_session()
        # No timer in a test: the window is sealed when the test says so.
        self.sensor._arm_idle = lambda: None

    def tearDown(self):
        sensor_module.time = self.real_time
        shutil.rmtree(self.dir, ignore_errors=True)

    def press(self, code, at, **event):
        self.clock.now = at
        self.sensor.on_key(key(code, **event))

    def release(self, code, at):
        self.clock.now = at
        self.sensor.on_key_released(key(code))

    def sealed(self, reason='idle'):
        """Seals the window and returns what was queued for it: (its session, the window)."""
        before = len(self.engine.state['queue'])
        self.sensor.flush(reason)
        queue = self.engine.state['queue']
        self.assertEqual(len(queue), before + 1)
        return queue[-1]['session'], queue[-1]['window']

    @staticmethod
    def keystrokes(window):
        return sum(run[1] for run in window['runs'] if len(run) == 3)

    # --- which releases are timed ---
    def test_a_key_is_timed_from_its_press_to_its_release(self):
        self.press(KEY_A, 1000.0)
        self.release(KEY_A, 1000.09)
        self.press(KEY_B, 1000.2)
        self.release(KEY_B, 1000.325)
        _, window = self.sealed()
        self.assertEqual(self.keystrokes(window), 2)
        self.assertEqual(window['dwell'], {'bins': [0, 0, 0, 0, 1, 0, 1], 'rollover': 0})

    def test_a_key_pressed_while_another_is_down_is_a_rollover(self):
        self.press(KEY_A, 1000.0)
        self.press(KEY_B, 1000.05)      # A is still down
        self.release(KEY_A, 1000.1)
        self.release(KEY_B, 1000.15)
        _, window = self.sealed()
        self.assertEqual(sum(window['dwell']['bins']), 2)
        self.assertEqual(window['dwell']['rollover'], 1)

    def test_a_held_key_is_one_press_however_the_repeat_arrives(self):
        """Auto-repeat sends presses with no release between them — or, on X11, a release
        before each one. Either way it is one keystroke and one hold, timed to the real
        release and not to the first one seen."""
        for base, fake_releases in ((1000.0, False), (2000.0, True)):
            with self.subTest(fake_releases=fake_releases):
                self.press(KEY_B, base)
                self.release(KEY_B, base + 0.11)
                self.press(KEY_A, base + 1.0)
                at = base + 1.0
                for _ in range(10):          # held: it repeats every 30 ms
                    at += 0.03
                    if fake_releases:
                        self.release(KEY_A, at - 0.001)
                    self.press(KEY_A, at)
                self.release(KEY_A, base + 1.4)
                _, window = self.sealed()
                self.assertEqual(self.keystrokes(window), 2)
                self.assertEqual(window['dwell']['bins'], [0, 0, 0, 0, 0, 1, 0, 0, 0, 1])

    def test_only_typing_is_timed(self):
        """An erase, a shortcut and a key without a key code are keystrokes, and none of them
        is a dwell time: the first two are not typing, and the keys without a code all share
        the code 0, so a release could not be matched to its press."""
        self.press(BACKSPACE, 1000.0)
        self.release(BACKSPACE, 1000.1)
        self.press(KEY_A, 1000.2, modifiers=CONSTANTS['com.sun.star.awt.KeyModifier.MOD1'])
        self.release(KEY_A, 1000.3)
        self.press(0, 1000.5, char='é')
        self.release(0, 1000.6)
        self.press(KEY_B, 1000.75)
        self.release(KEY_B, 1000.85)
        _, window = self.sealed()
        self.assertEqual(window['runs'], [['erase', 1, 0], ['other', 1, 0], ['type', 2, 250]])
        self.assertEqual(sum(window['dwell']['bins']), 1)

    def test_altgr_types_a_character_like_any_other(self):
        ctrl_alt = CONSTANTS['com.sun.star.awt.KeyModifier.MOD1'] | CONSTANTS['com.sun.star.awt.KeyModifier.MOD2']
        self.press(KEY_A, 1000.0)
        self.press(KEY_B, 1000.25, modifiers=ctrl_alt, char='@')
        self.press(KEY_C, 1000.5)
        _, window = self.sealed()
        self.assertEqual(window['runs'], [['type', 3, 500]])

    def test_a_release_after_the_window_was_sealed_is_timed_nowhere(self):
        self.press(KEY_A, 1000.0)
        self.sealed()
        self.release(KEY_A, 1000.5)
        self.sensor.measure.on_paste(1001.0, 'x' * 30)
        _, window = self.sealed()
        self.assertEqual(window['dwell'], {'bins': [], 'rollover': 0})

    # --- the reading of the text ---
    def test_the_text_is_read_with_the_count_and_never_more_often(self):
        self.press(KEY_A, 1000.0)
        self.doc.text = 'Introduction a'
        self.press(KEY_B, 1002.0)       # less than VOLUME_REFRESH_S later: the cache answers
        self.assertEqual(self.doc.reads, 1)
        _, window = self.sealed()
        self.assertEqual(window['text'], {'len': 12})    # a first reading has nothing before it

        self.press(KEY_A, 1003.0)
        _, window = self.sealed()
        self.assertEqual(self.doc.reads, 1)
        self.assertEqual(window['text'], {'len': 12})    # the count came from the cache

        self.press(KEY_A, 1010.0)
        _, window = self.sealed()
        self.assertEqual(self.doc.reads, 2)
        self.assertEqual(window['text'], {'len': 14, 'since': 0, 'at': 12, 'cut': 0, 'add': 2, 'kept': 0})

    def test_paragraph_breaks_are_not_counted_in_the_span(self):
        self.doc.text = 'Titre\nUn'
        self.press(KEY_A, 1000.0)
        self.sealed()
        self.doc.text = 'Titre\r\nUn\nDeux'
        self.press(KEY_A, 1010.0)
        _, window = self.sealed()
        self.assertEqual(window['text'], {'len': 11, 'since': 0, 'at': 7, 'cut': 0, 'add': 4, 'kept': 0})

    def test_a_count_the_body_text_does_not_explain_carries_no_span(self):
        """Writer counts what the body does not hold — a footnote, a frame. The size is sent
        as ever; the span is not, rather than said of another text than the one counted. And
        the next reading that does agree is compared to the last one that did."""
        self.press(KEY_A, 1000.0)
        self.sealed()
        self.doc.text = 'Introduction b'
        self.doc.count = 40
        self.press(KEY_A, 1010.0)
        _, window = self.sealed()
        self.assertEqual(window['text'], {'len': 40})
        self.doc.count = None
        self.press(KEY_A, 1020.0)
        _, window = self.sealed()
        self.assertEqual(window['text'], {'len': 14, 'since': 0, 'at': 12, 'cut': 0, 'add': 2, 'kept': 0})

    def test_a_count_that_cannot_be_read_sends_no_text_at_all(self):
        def unreadable(name):
            raise RuntimeError('the bridge no longer answers')
        self.doc.getPropertyValue = unreadable
        self.press(KEY_A, 1000.0)
        _, window = self.sealed()
        self.assertNotIn('text', window)
        self.assertEqual(self.doc.reads, 0)             # and the text is not read without it

    # --- sessions ---
    def test_a_suspension_ends_the_session_and_lets_the_text_go(self):
        self.press(KEY_A, 1000.0)
        first, _ = self.sealed()
        self.press(KEY_A, 1010.0)
        self.sensor.flush('pause')                       # what the window does before suspending
        self.engine.set_paused(True)
        self.assertIsNone(self.sensor.measure.session)
        self.assertIsNone(self.sensor.measure.previous_text)
        self.assertIsNone(self.sensor.reading)

        reads = self.doc.reads
        self.press(KEY_A, 1020.0)                        # suspended: nothing is counted, or read
        self.sensor.flush('save')
        self.assertEqual(self.doc.reads, reads)
        self.assertEqual(len(self.engine.state['queue']), 2)

        self.engine.set_paused(False)
        self.press(KEY_A, 1030.0)
        session, resumed = self.sealed()
        self.assertNotEqual(session, first)
        self.assertEqual(resumed['seq'], 0)
        self.assertEqual(resumed['mono'], 0)             # the clock of a session starts with it
        self.assertEqual(resumed['text'], {'len': 12})   # and its first reading has none before it

    def test_another_document_s_sensor_sees_the_suspension_lifted(self):
        """The window suspends from one document; the sensors of the others are told nothing.
        They find out at their next event, and what they count from there is a new session."""
        self.press(KEY_A, 1000.0)
        first, _ = self.sealed()
        self.engine.set_paused(True)
        self.engine.set_paused(False)
        self.press(KEY_A, 1010.0)
        second, window = self.sealed()
        self.assertNotEqual(second, first)
        self.assertEqual(window['seq'], 0)

    def test_a_window_open_when_the_suspension_is_noticed_is_sealed_in_its_own_session(self):
        self.press(KEY_A, 1000.0)
        session = self.sensor.measure.session
        self.engine.set_paused(True)
        self.press(KEY_A, 1001.0)                        # not counted, and seals what was open
        (item,) = self.engine.state['queue']
        self.assertEqual((item['session'], item['window']['seq'], item['window']['why']), (session, 0, 'end'))
        self.assertEqual(self.keystrokes(item['window']), 1)

    def test_closing_the_document_ends_the_session(self):
        self.press(KEY_A, 1000.0)
        _, window = self.sealed('pagehide')
        self.assertEqual((window['seq'], window['why']), (0, 'end'))
        self.assertIsNone(self.sensor.measure.session)
        self.assertIsNone(self.sensor.measure.previous_text)

    def test_a_timeline_about_to_overflow_is_sealed_on_a_paste(self):
        self.sensor.ctx = None
        real = sensor_module.clipboard_text
        sensor_module.clipboard_text = lambda ctx: 'x' * 20
        try:
            for index in range(m.TIMELINE_MAX_RUNS):
                self.clock.now = 1000.0 + index
                self.sensor.on_paste()
        finally:
            sensor_module.clipboard_text = real
        queue = self.engine.state['queue']
        self.assertEqual([len(item['window']['runs']) for item in queue],
                         [m.TIMELINE_MAX_RUNS - m.TIMELINE_HEADROOM])
        self.assertEqual(queue[0]['window']['why'], 'volume')

    def test_and_on_a_click_or_a_copy_with_every_run_in_it(self):
        """Clicks and copies open no window of their own, but their runs are sent with the next
        one — so a timeline they alone are about to fill is sealed too, rather than sent short
        of a run. The document gets its identity for it: the window has to go somewhere."""
        real = sensor_module.selection_text
        sensor_module.selection_text = lambda doc: 'un mot'
        try:
            for index in range(m.TIMELINE_MAX_RUNS + 2):
                self.clock.now = 1000.0 + index
                self.sensor.on_click() if index % 2 else self.sensor.on_copy()
        finally:
            sensor_module.selection_text = real
        (item,) = self.engine.state['queue']
        self.assertEqual(len(item['window']['runs']), m.TIMELINE_MAX_RUNS - m.TIMELINE_HEADROOM)
        self.assertEqual({run[0] for run in item['window']['runs']}, {'click', 'copy'})
        self.assertEqual(item['window']['why'], 'volume')
        self.assertEqual(len(self.sensor.measure.window.timeline), 2 + m.TIMELINE_HEADROOM)


if __name__ == '__main__':
    unittest.main()
