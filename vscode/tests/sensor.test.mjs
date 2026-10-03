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
    // The document the host reads: its volume at flush time, and its text when a block lands in
    // one shot. A test that duplicates a line replaces it, the way the editor would.
    let body = text;
    // How many times the document was read. `getText()` rebuilds the whole file as a string, so
    // what keeps a paste at a hundred cursors from costing a hundred files is only visible by
    // counting the reads.
    const reads = { text: 0 };
    const instance = new Sensor({
        documentId: 'vscode:abcd1234:src/main.go',
        documentName: 'tp-go/src/main.go',
        volume: () => chars(body),
        text: () => {
            reads.text++;
            return body;
        },
        flushed: (item) => flushed.push(item),
    });
    return {
        time,
        flushed,
        instance,
        reads,
        // What the document holds after the edit under test — VS Code delivers the change once
        // the document already carries it.
        holds(next) {
            body = next;
        },
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

test('a block the document already held is a duplication, not an import', async (t) => {
    const line = 'if err != nil { return fmt.Errorf("lecture du devoir: %w", err) }';

    // The editor gives neither the clipboard nor the content of what a change replaces, so the
    // trick the three other agents use — remember what leaves the document, recognise it coming
    // back — is closed here. What it does give is the document, and a text the document already
    // held cannot have been imported by the gesture putting it there a second time. Without
    // this, copying one of your own lines and pasting it twice was counted as text from
    // elsewhere, and a file that repeats itself was accused of never having been typed.
    await t.test('the same line pasted again', () => {
        const s = sensor({ text: `func read() error {\n\t${line}\n}` });
        s.holds(`func read() error {\n\t${line}\n\t${line}\n}`);
        s.type(line);
        assert.equal(s.counters.injectedChars, 0);
        assert.equal(s.counters.selfPasteChars, chars(line));
        assert.equal(s.counters.keystrokes, 1, 'the gesture that laid the block down');
    });

    await t.test('a line the document never held is still an injection', () => {
        const s = sensor({ text: `func read() error {\n\t${line}\n}` });
        const foreign = 'return errors.New("une réponse entièrement rédigée ailleurs")';
        s.holds(`func read() error {\n\t${line}\n\t${foreign}\n}`);
        s.type(foreign);
        assert.equal(s.counters.selfPasteChars, 0);
        assert.equal(s.counters.injectedChars, chars(foreign));
    });

    // One gesture can carry several insertions: pasting at five cursors inserts the same text
    // five times at once. Those five are the paste's own and cannot excuse it.
    await t.test('a paste at several cursors is not excused by its own copies', () => {
        const s = sensor();
        const foreign = 'return errors.New("une réponse entièrement rédigée ailleurs")';
        s.holds([foreign, foreign, foreign].join('\n'));
        s.edit([
            { text: foreign, rangeLength: 0 },
            { text: foreign, rangeLength: 0 },
            { text: foreign, rangeLength: 0 },
        ]);
        assert.equal(s.counters.selfPasteChars, 0);
        assert.equal(s.counters.injectedChars, 3 * chars(foreign));
    });

    // Reading the document is the price of this rule, and it is paid once for the gesture: one
    // paste at a hundred cursors is a hundred changes carrying the same block, which is one
    // question. An ordinary keystroke never asks it at all.
    await t.test('the document is read once for the event, never once per cursor', () => {
        const s = sensor();
        const foreign = 'return errors.New("une réponse entièrement rédigée ailleurs")';
        s.holds(Array.from({ length: 100 }, () => foreign).join('\n'));
        s.edit(Array.from({ length: 100 }, () => ({ text: foreign, rangeLength: 0 })));
        assert.equal(s.reads.text, 1);
    });

    await t.test('typing does not read the document', () => {
        const s = sensor();
        s.type('func ');
        s.type('read');
        assert.equal(s.reads.text, 0);
    });

    // The volume is what the engine reads it for: it is the figure that explains why a document
    // is longer than what was typed, and it is the one thing this agent can say about a
    // restitution — the *number* of them would be a guess (a paste and an accepted completion
    // are the same event here).
    await t.test('the volume travels, the count does not', () => {
        const s = sensor({ text: `func read() error {\n\t${line}\n}` });
        s.holds(`func read() error {\n\t${line}\n\t${line}\n}`);
        s.type(line);
        s.instance.flush('manual');
        assert.equal(s.flushed[0].values.self_paste_chars_total, chars(line));
        assert.equal(s.flushed[0].values.self_paste_events, undefined);
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

    // The rule the four agents share: what arrives in one block is weighed in characters, never
    // in keystrokes. This agent never saw a key either, so it has always counted it that way.
    await t.test('an insertion made in one go is no keystroke at all', () => {
        const s = sensor();
        s.edit([{ text: 'w'.repeat(400), rangeLength: 0 }]);
        assert.equal(s.counters.injectedChars, 400);
        assert.equal(s.counters.keystrokes, 0);
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

// The counters added for the vectors the model could not see. Deliberately the same cases as
// `browser/tests/sensor.test.mjs` and `libreoffice/tests/test_measure.py`: a divergence between
// the implementations shows up here first. The volume of a restitution is missing from this
// agent for the reason restitutions are (see `docs/mesures.md`, *Écarts assumés*).
test('the proof of life, and what is typed on returning', async (t) => {
    await t.test('a silence of one to three seconds is a word search', () => {
        const s = sensor();
        s.type('m');
        s.type('o', { seconds: 1.6 });   // too long to be a flight time, too short to be a pause
        assert.equal(s.counters.hesitations, 1);
        assert.equal(s.counters.pauses, 0, 'and it is not counted twice as a cognitive pause');
    });

    await t.test('a fluent keystroke is not one', () => {
        const s = sensor();
        s.type('m');
        s.type('o', { seconds: 0.2 });
        assert.equal(s.counters.hesitations, 0);
    });

    // The band exists because neither neighbouring rule covers it: below 800 ms it is a flight
    // time, past 3 s it is a cognitive pause. A silence of four seconds belongs to the pause.
    await t.test('a real pause stays a pause', () => {
        const s = sensor();
        s.type('m');
        s.type('o', { seconds: 4 });
        assert.equal(s.counters.hesitations, 0);
        assert.equal(s.counters.pauses, 1);
    });

    // An insertion made in one go is a paste, a snippet or an accepted completion here, and the
    // API does not say which: it is weighed as an injection, never as typing.
    await t.test('a completion accepted in one go is not a hesitation either', () => {
        const s = sensor();
        s.type('m');
        s.edit([{ text: 'w'.repeat(800), rangeLength: 0 }], { seconds: 1.6 });
        assert.equal(s.counters.hesitations, 0);
    });

    await t.test('typing just after a return to the editor is counted apart', () => {
        const s = sensor();
        s.type('du code');
        s.blur();
        s.comeBack();
        s.type('abcde');
        assert.equal(s.counters.keystrokesAfterReturn, 5,
            'leave, read, come back and type: the gesture no counter saw');
    });

    // Every keystroke goes through one counter, as it does in the three other agents: a
    // deletion and an undo are keystrokes, so they are keystrokes after a return too. Counting
    // only the insertions would have made this agent's figure a different one under the same
    // name — and nothing on the engine's side could have told.
    await t.test('erasing and undoing after a return are counted there too', () => {
        const s = sensor();
        s.type('du code');
        s.blur();
        s.comeBack();
        s.erase(3);
        s.edit([{ text: 'du code', rangeLength: 0 }], { reason: 'undo' });
        assert.equal(s.counters.keystrokesAfterReturn, 4);
        assert.equal(s.counters.keystrokes, 4, 'a subset of the keystrokes, never an addition');
    });

    await t.test('typing long after a return is ordinary writing', () => {
        const s = sensor();
        s.type('du code');
        s.blur();
        s.comeBack();
        s.type('abcde', { seconds: 20 });   // past RETURN_WINDOW_MS
        assert.equal(s.counters.keystrokesAfterReturn, 0);
    });

    await t.test('without having left, there is no return', () => {
        const s = sensor();
        s.type('du code');
        s.comeBack();
        s.type('abcde');
        assert.equal(s.counters.keystrokesAfterReturn, 0);
    });
});

// A window is not a burst of typing: it is a span the agent decided to close, and the engine
// cannot tell its triggers apart on its own. This extension has the most of them — a command
// can seal a window here — and the words it sends are the four agents' shared vocabulary.
test('why the window was sealed travels with it', async (t) => {
    const sealedBy = (reason) => {
        const s = sensor();
        s.type('du code');
        s.instance.flush(reason);
        return s.flushed.at(-1).flush;
    };

    await t.test('the writer stopping, and the counter stopping, are not the same word', () => {
        assert.equal(sealedBy('idle'), 'idle');
        assert.equal(sealedBy('volume'), 'volume');
    });

    // What the engine reads `save` for is "an explicit action of the student's sealed the
    // window while they were still writing" — which is as true of handing in, of renaming, and
    // of pressing "send now" as it is of Ctrl+S.
    await t.test('the commands that cut a burst all say the same thing', () => {
        for (const reason of ['save', 'submit', 'rename', 'manual']) {
            assert.equal(sealedBy(reason), 'save', reason);
        }
    });

    await t.test('leaving the editor is an absence, and closing it is the end of a sitting', () => {
        assert.equal(sealedBy('blur'), 'away');
        for (const reason of ['close', 'pause', 'deactivate']) {
            assert.equal(sealedBy(reason), 'end', reason);
        }
    });

    // The safe failure: a trigger the table does not know sends nothing at all, and the engine
    // reads nothing as "the agent did not say". It never sends a word outside the vocabulary.
    await t.test('a trigger the table does not know says nothing', () => {
        assert.equal(sealedBy('something-new'), undefined);
    });
});
