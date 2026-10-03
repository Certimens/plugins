// Sensor of the VS Code extension (src/sensor.js).
//
// VS Code does not deliver keystrokes: it says what changed in the document and where the
// cursor comes from. The cases below are deliberately those of the two other suites — a
// divergence between the three implementations shows up here first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, load } from './helpers/sandbox.mjs';

// The shipped file is loaded as it is: it is its production `module.exports` that the test
// uses, nothing is added to the code to make it observable.
function sensorModule() {
    const module = { exports: {} };
    load(new URL('../src/sensor.js', import.meta.url), { globals: { module } });
    return module.exports;
}

const { Sensor, chars, median, medianAbsoluteDeviation } = sensorModule();

function sensor({ text = 'du code' } = {}) {
    const time = clock();
    const flushed = [];
    const instance = new Sensor({
        documentId: 'vscode:abcd1234:src/main.go',
        documentName: 'tp-go/src/main.go',
        volume: () => chars(text),
        flushed: (item) => flushed.push(item),
    });
    return {
        time,
        flushed,
        instance,
        get counters() {
            return instance.measure;
        },
        // An edit to the document, `seconds` after the previous one.
        edit(changes, { seconds = 0.1, reason = '' } = {}) {
            instance.change(changes, reason, time.advance(seconds));
        },
        type(text, { seconds = 0.1 } = {}) {
            instance.change([{ text, rangeLength: 0 }], '', time.advance(seconds));
        },
        erase(count, { seconds = 0.1 } = {}) {
            instance.change([{ text: '', rangeLength: count }], '', time.advance(seconds));
        },
        move(kind, selected = false, { seconds = 0.5 } = {}) {
            instance.move(kind, selected, time.advance(seconds));
        },
        blur({ seconds = 0.1 } = {}) {
            time.advance(seconds);
            instance.blur();
        },
        comeBack({ seconds = 1 } = {}) {
            instance.focus(time.advance(seconds));
        },
        // `Sensor.flush` returns the window produced, or null when there was nothing to send.
        flush(reason = 'test') {
            return instance.flush(reason);
        },
    };
}

test('what counts as a keystroke', async (t) => {
    await t.test('an inserted character', () => {
        const s = sensor();
        s.type('f');
        s.type('u');
        assert.equal(s.counters.keystrokes, 2);
    });

    await t.test('a line break is a keystroke, but not a character', () => {
        const s = sensor();
        s.type('\n');
        assert.equal(s.counters.keystrokes, 1);
        assert.equal(chars('a\nb'), 2);
    });

    await t.test('a deletion costs as many keystrokes as characters erased', () => {
        const s = sensor();
        s.erase(3);
        assert.equal(s.counters.keystrokes, 3);
        assert.equal(s.counters.corrections, 3);
    });

    await t.test('a block erased in one go counts as a single keystroke', () => {
        const s = sensor();
        s.erase(120);
        assert.equal(s.counters.keystrokes, 1);
        assert.equal(s.counters.macroRevisions, 1);
    });
});

test('an insertion made in one go is an injection', async (t) => {
    await t.test('past 15 characters', () => {
        const s = sensor();
        s.type('func main() { fmt.Println("bonjour") }');
        assert.equal(s.counters.injectedChars, 38);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('below that they are keystrokes — a short completion stays typing', () => {
        const s = sensor();
        s.type('Println');
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.keystrokes, 7);
    });

    await t.test('line breaks do not inflate the count', () => {
        const s = sensor();
        s.type('if err != nil {\n\treturn err\n}\n');
        assert.equal(s.counters.injectedChars, chars('if err != nil {\n\treturn err\n}\n'));
    });
});

test('a deletion settles the move preceding it', async (t) => {
    await t.test('after a click: mass revision, then immediate corrections', () => {
        const s = sensor();
        s.move('mouse');
        s.erase(1);
        s.erase(1);
        s.erase(1);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.corrections, 2);
        assert.equal(s.counters.reformulations, 0);
    });

    await t.test('after a keyboard move: deferred reformulation, then corrections', () => {
        const s = sensor();
        s.move('keyboard');
        s.erase(1);
        s.erase(1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('without a move: immediate correction', () => {
        const s = sensor();
        s.type('a');
        s.erase(1);
        assert.equal(s.counters.corrections, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });
});

test('replacing a selection is a deletion', async (t) => {
    await t.test('at the scale of a selection swept with the mouse: a mass revision', () => {
        const s = sensor();
        s.move('mouse', true);
        s.edit([{ text: 'x', rangeLength: 12 }]);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.reformulations, 0);
        // the keystroke replacing it, plus the block erased
        assert.equal(s.counters.keystrokes, 2);
    });

    await t.test('a Shift+arrow selection is a deferred reformulation', () => {
        const s = sensor();
        s.move('keyboard', true);
        s.edit([{ text: 'x', rangeLength: 4 }]);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    await t.test('"select all" arrives as a command and weighs like a block', () => {
        const s = sensor();
        s.move('command', true);
        s.edit([{ text: 'réponse collée et retapée', rangeLength: 800 }]);
        assert.equal(s.counters.macroRevisions, 1);
        assert.equal(s.counters.injectedChars, 25);
    });

    await t.test('a move without a selection cancels it', () => {
        const s = sensor();
        s.move('mouse', true);
        s.move('keyboard', false);
        s.erase(1);
        // the click was cancelled by the keyboard move: reformulation, not mass revision
        assert.equal(s.counters.macroRevisions, 0);
        assert.equal(s.counters.reformulations, 1);
    });
});

test('undo counts one correction without replaying what it restores', () => {
    const s = sensor();
    s.edit([{ text: 'un paragraphe entier restauré par Ctrl+Z', rangeLength: 0 }], { reason: 'undo' });
    assert.equal(s.counters.corrections, 1);
    assert.equal(s.counters.keystrokes, 1);
    assert.equal(s.counters.injectedChars, 0);
});

test('moves', async (t) => {
    await t.test('count as navigation jumps', () => {
        const s = sensor();
        s.move('mouse');
        s.move('keyboard');
        assert.equal(s.counters.navigation, 2);
    });

    await t.test('the one right after a keystroke is the cursor\'s echo, not a navigation', () => {
        const s = sensor();
        s.type('a');
        s.move('keyboard', false, { seconds: 0.02 }); // 20 ms: the cursor follows what was just typed
        assert.equal(s.counters.navigation, 0);
    });

    await t.test('on their own, they open no window', () => {
        const s = sensor();
        s.move('mouse');
        s.move('keyboard');
        assert.equal(s.flush(), null);
        assert.equal(s.flushed.length, 0);
    });
});

test('cognitive pauses', async (t) => {
    await t.test('resuming between 3 s and 5 min is one', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 10 });
        assert.equal(s.counters.pauses, 1);
    });

    await t.test('below 3 s, nothing', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 2 });
        assert.equal(s.counters.pauses, 0);
    });

    await t.test('past 5 min, the student has left the document', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 400 });
        assert.equal(s.counters.pauses, 0);
    });
});

test('effective time', async (t) => {
    await t.test('a short gap counts for as long as it lasts', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 1.5 });
        assert.equal(s.counters.activeMs, 1500);
    });

    await t.test('a middling gap counts as a flat 250 ms', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 30 });
        assert.equal(s.counters.activeMs, 250);
    });

    await t.test('a gap of more than 60 s does not count', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 120 });
        assert.equal(s.counters.activeMs, 0);
    });
});

test('typing rhythm', async (t) => {
    await t.test('is measured on changes the size of a keystroke', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 0.1 });
        s.type('c', { seconds: 0.15 });
        const window = s.flush();
        assert.equal(window.values.flight_median_ms, 125);
        assert.equal(window.values.flight_mad_ms, 25);
    });

    await t.test('a completion accepted in one go does not enter the sample', () => {
        const s = sensor();
        s.type('a');
        s.type('func (s *Sensor) Measure(now int64) error {', { seconds: 0.1 });
        s.type('b', { seconds: 0.1 });
        // two keystrokes separated by an injection: a single flight time, hence no rhythm
        assert.equal(s.counters.flights.length, 1);
        assert.equal(s.flush().values.flight_median_ms, undefined);
    });

    await t.test('a gap of more than 800 ms is not a flight time', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 2 });
        assert.equal(s.counters.flights.length, 0);
    });

    await t.test('the median and its median absolute deviation', () => {
        assert.equal(median([10, 20, 30]), 20);
        assert.equal(median([10, 20]), 15);
        assert.equal(medianAbsoluteDeviation([100, 100, 100]), 0);
        assert.equal(medianAbsoluteDeviation([10]), 0);
    });
});

test('leaving the document', async (t) => {
    await t.test('counts one departure and closes the window', () => {
        const s = sensor();
        s.type('a');
        s.blur();
        const window = s.flushed[0];
        assert.equal(window.values.focus_losses, 1);
        assert.equal(window.reason, 'blur');
    });

    await t.test('with no activity, it creates no empty window', () => {
        const s = sensor();
        s.move('mouse');
        s.blur();
        assert.equal(s.flushed.length, 0);
    });
});

test('the window sent', async (t) => {
    await t.test('runs from the first to the last activity, never beyond', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 4 });
        const { period } = s.flush();
        assert.equal(new Date(period.end) - new Date(period.start), 4000);
    });

    await t.test('lasts at least one second: the engine demands an end after the start', () => {
        const s = sensor();
        s.type('a');
        const { period } = s.flush();
        assert.equal(new Date(period.end) - new Date(period.start), 1000);
    });

    await t.test('carries the document volume and its path in the project', () => {
        const s = sensor({ text: 'package main\n' });
        s.type('a');
        const window = s.flush();
        assert.equal(window.values.real_volume_chars, 12); // without the line break
        assert.equal(window.documentName, 'tp-go/src/main.go');
        assert.equal(window.documentId, 'vscode:abcd1234:src/main.go');
    });

    await t.test('does not send paste_events: VS Code cannot tell a paste from a completion', () => {
        const s = sensor();
        s.type('un texte collé de plus de quinze caractères');
        assert.equal('paste_events' in s.flush().values, false);
    });

    await t.test('goes out on its own after 200 keystrokes', () => {
        const s = sensor();
        for (let i = 0; i < 200; i++) s.type('a', { seconds: 0.05 });
        assert.equal(s.flushed.length, 1);
        assert.equal(s.flushed[0].reason, 'volume');
        assert.equal(s.flushed[0].values.keystrokes_total, 200);
    });

    await t.test('starts again from zero: an emptied window is not sent twice', () => {
        const s = sensor();
        s.type('a');
        s.flush();
        assert.equal(s.counters.keystrokes, 0);
        assert.equal(s.flush(), null);
        assert.equal(s.flushed.length, 1);
    });
});

test('the biggest contribution, and what arrives after a return', async (t) => {
    await t.test('`injected_chars_max` keeps the biggest, not the last', () => {
        // Here it is also the size of what was accepted in one gesture: a completion, a block
        // proposed by an assistant. The total alone does not say it.
        const s = sensor();
        s.edit([{ text: 'x'.repeat(100), rangeLength: 0 }]);
        s.edit([{ text: 'y'.repeat(2000), rangeLength: 0 }]);
        s.edit([{ text: 'z'.repeat(40), rangeLength: 0 }]);
        assert.equal(s.counters.injectedChars, 2140);
        assert.equal(s.counters.maxInjectedChars, 2000);
    });

    await t.test('an insertion the size of a keystroke does not enter it', () => {
        const s = sensor();
        s.type('a');
        assert.equal(s.counters.maxInjectedChars, 0);
    });

    await t.test('what arrives right after a return is counted apart', () => {
        // Leaving the editor, going to look something up, coming back and pasting is a single
        // gesture, and it is the one made when fetching code from elsewhere.
        const s = sensor();
        s.type('du code');
        s.blur();
        s.comeBack();
        s.edit([{ text: 'w'.repeat(800), rangeLength: 0 }]);
        assert.equal(s.counters.injectedChars, 800);
        assert.equal(s.counters.injectedCharsAfterReturn, 800, 'a strict subset of the total');
    });

    await t.test('past the delay, an insertion becomes an insertion like any other', () => {
        const s = sensor();
        s.type('du code');
        s.blur();
        s.comeBack();
        // Twenty seconds later, past RETURN_WINDOW_MS.
        s.edit([{ text: 'w'.repeat(800), rangeLength: 0 }], { seconds: 20 });
        assert.equal(s.counters.injectedCharsAfterReturn, 0);
    });

    await t.test('without having left, there is no return', () => {
        const s = sensor();
        s.type('du code');
        s.comeBack();
        s.edit([{ text: 'w'.repeat(800), rangeLength: 0 }]);
        assert.equal(s.counters.injectedCharsAfterReturn, 0);
    });
});

test('counting characters means counting code points', () => {
    // `chars()` is called on the whole file at every window (`volume()` in extension.js): it no
    // longer builds the array `[...text]` allocates, and must return exactly the same number —
    // the engine counts a submitted copy the same way.
    for (const text of ['', 'abc', 'a😀b', '😀😀', 'été', '\uD83D', 'x\uD83Dy']) {
        assert.equal(chars(text), [...text].length, JSON.stringify(text));
    }
    assert.equal(chars('deux\nlignes'), 10, 'line breaks do not count');
});
