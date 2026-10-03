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

// The sensor runs in its own context, so what it builds is compared by value, not by identity
// of prototype — and what is compared is then exactly what a serialiser would write.
const plain = (value) => JSON.parse(JSON.stringify(value));

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
    const sessions = { opened: 0 };
    const instance = new Sensor({
        documentId: 'vscode:abcd1234:src/main.go',
        documentName: 'tp-go/src/main.go',
        volume: () => chars(body),
        text: () => {
            reads.text++;
            return body;
        },
        flushed: (item) => flushed.push(item),
        // What the host draws and reads for a session: a name nothing derives from, and a
        // clock that never goes back. Both are the test's here, so a session is recognisable
        // and the two clocks are not the same number.
        newSession: () => `session-${String(++sessions.opened).padStart(14, '0')}`,
        monotonic: () => time.now - 400_000,
    });
    return {
        time,
        flushed,
        instance,
        reads,
        sessions,
        // What the document holds after the edit under test — VS Code delivers the change once
        // the document already carries it.
        holds(next) {
            body = next;
        },
        get counters() {
            return instance.measure;
        },
        // The runs of the window in progress, without their durations: `[kind, n]`, and
        // `['gap', ms]` for a silence.
        get runs() {
            return plain(instance.measure.runs.map((run) => (run.kind === 'gap' ? ['gap', run.ms] : [run.kind, run.n])));
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
        // `to`: where the caret landed, when the test cares how far it went.
        move(kind, selected = false, { seconds = 0.5, to = null } = {}) {
            instance.move(kind, selected, time.advance(seconds), to);
        },
        blur({ seconds = 0.1 } = {}) {
            time.advance(seconds);
            instance.blur();
        },
        comeBack({ seconds = 1 } = {}) {
            time.advance(seconds);
            instance.focus();
        },
        // `Sensor.flush` returns the queue entry produced, or null when there was nothing to
        // send; what leaves for the engine is its `window`.
        flush(reason = 'idle') {
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
        assert.deepEqual(s.runs, [['paste', 38]]);
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
        assert.equal(s.counters.pastes, 0);
        assert.deepEqual(s.runs, [['other', 1], ['self', chars(line)]]);
        assert.equal(s.counters.keystrokes, 1, 'the gesture that laid the block down');
    });

    await t.test('a line the document never held is still an injection', () => {
        const s = sensor({ text: `func read() error {\n\t${line}\n}` });
        const foreign = 'return errors.New("une réponse entièrement rédigée ailleurs")';
        s.holds(`func read() error {\n\t${line}\n\t${foreign}\n}`);
        s.type(foreign);
        assert.deepEqual(s.runs, [['paste', chars(foreign)]]);
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
        assert.deepEqual(s.runs, [1, 2, 3].map(() => ['paste', chars(foreign)]), 'one run per block');
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

    // Its size is what the engine reads it for: it is the figure that explains why a document
    // is longer than what was typed. It leaves as a run of its own kind, and adds nothing to
    // what the session says was brought from elsewhere.
    await t.test('it leaves as a `self` run of its size, and is no paste in the sums', () => {
        const s = sensor({ text: `func read() error {\n\t${line}\n}` });
        s.holds(`func read() error {\n\t${line}\n\t${line}\n}`);
        s.type(line);
        const { window } = s.flush('manual');
        assert.deepEqual(plain(window.runs), [['other', 1, 0], ['self', chars(line)]]);
        assert.deepEqual(plain(window.sum), { keys: 1, chars: 0, pastes: 0 });
    });
});

test('a deletion settles the move preceding it', async (t) => {
    // A plain click is a local retouch, not a restructuring: clicking into a word three lines up
    // and taking its ending off is the deferred reformulation the counter is named for. Filing it
    // as a mass revision at five times the weight was the single largest reason that counter
    // never fired. A drag still arrives as a block selection and is still a mass revision.
    await t.test('after a click: deferred reformulation, then immediate corrections', () => {
        const s = sensor();
        s.move('mouse');
        s.erase(1);
        s.erase(1);
        s.erase(1);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 2);
        assert.equal(s.counters.macroRevisions, 0);
    });

    // One gesture, one revision. A word taken out used to arrive as one count per character,
    // which is how the counter could be large for a trivial edit and empty for a real one.
    await t.test('a word taken out on the spot is one reformulation, not seven corrections', () => {
        const s = sensor();
        s.erase(7);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.corrections, 0);
        assert.equal(s.counters.macroRevisions, 0);
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

    // Backspace hammered through a phrase arrives one change at a time, like one press at a
    // time in the browser: the run is one gesture, read once past a word's worth.
    await t.test('a run of single erases is one reformulation past a word', () => {
        const s = sensor();
        for (let i = 0; i < 9; i++) s.erase(1);
        assert.equal(s.counters.corrections, 5);
        assert.equal(s.counters.reformulations, 1);
        assert.equal(s.counters.macroRevisions, 0);
    });

    // The shape the rule used to drop in silence: going back to insert the word that was
    // missing, erasing nothing. A click is a trip on its own.
    await t.test('an insertion after a trip is a reformulation', () => {
        const s = sensor();
        s.move('keyboard');
        s.move('keyboard');
        s.type('x');
        assert.equal(s.counters.reformulations, 1);
        const c = sensor();
        c.move('mouse');
        c.type('x');
        assert.equal(c.counters.reformulations, 1);
        assert.equal(c.counters.macroRevisions, 0);
    });

    // One arrow is a brush against the key, and it must not linger: typing settles it, so the
    // typo repaired right after is a correction made on the spot, as in the three other sensors.
    await t.test('a single nudge leaves an insertion alone, and does not survive it', () => {
        const s = sensor();
        s.type('a');
        s.move('keyboard');
        s.type('b');
        s.erase(1);
        assert.equal(s.counters.reformulations, 0);
        assert.equal(s.counters.corrections, 1);
    });

    // VS Code says where the caret went, not which key sent it: one character along the line
    // or one line up or down is an arrow, anything further is Home, End, a page or a word jump.
    await t.test('a keyboard move is a nudge or a jump by its distance', () => {
        const s = sensor();
        s.move('keyboard', false, { to: { line: 2, character: 8 } });
        s.type('a');
        s.move('keyboard', false, { to: { line: 2, character: 0 } });  // Home
        s.type('b');
        assert.equal(s.counters.reformulations, 1);
        const n = sensor();
        n.move('keyboard', false, { to: { line: 2, character: 8 } });
        n.type('a');
        n.move('keyboard', false, { to: { line: 3, character: 8 } });  // an arrow down
        n.type('b');
        assert.equal(n.counters.reformulations, 0);
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

// The sensor tells every silence of a second or more between two counted keystrokes, at its
// real length, and classes none of them: a word being looked for, a thought and a departure are
// read by the engine from the duration. So what is held here is where a `gap` is written — and
// that nothing else is.
test('silences', async (t) => {
    await t.test('a second or more between two keystrokes is a gap, at its real length', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 10 });
        assert.deepEqual(s.runs, [['type', 1], ['gap', 10_000], ['type', 1]]);
    });

    await t.test('exactly a second is one; just under is typing that goes on', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 1 });
        s.type('c', { seconds: 0.999 });
        assert.deepEqual(s.runs, [['type', 1], ['gap', 1000], ['type', 2]]);
    });

    await t.test('there is no ceiling, and no class: six minutes are told as six minutes', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 1.6 });
        s.type('c', { seconds: 4 });
        s.type('d', { seconds: 400 });
        assert.deepEqual(s.runs.filter(([kind]) => kind === 'gap'), [['gap', 1600], ['gap', 4000], ['gap', 400_000]]);
    });

    // A silence lies between two **counted keystrokes**. A caret move and a block end none:
    // neither is a keystroke, and a gap that one of them closed would be a silence the
    // keystrokes of the runs do not bracket.
    await t.test('a click or a block ends no silence', () => {
        const s = sensor();
        s.type('a');
        s.move('mouse', false, { seconds: 10 });
        s.edit([{ text: 'x'.repeat(500), rangeLength: 0 }], { seconds: 10 });
        assert.deepEqual(s.runs, [['type', 1], ['click', 1], ['paste', 500]]);
    });

    await t.test('the silence spent clicking is one gap when typing resumes', () => {
        const s = sensor();
        s.type('a');
        s.move('mouse', false, { seconds: 10 });
        s.move('mouse', false, { seconds: 10 });
        s.type('b', { seconds: 10 });
        assert.deepEqual(s.runs, [['type', 1], ['click', 2], ['gap', 30_000], ['type', 1]], 'one silence, not three');
    });

    // Every counted keystroke ends a silence, whatever its kind: an erase of several
    // characters, an undo and the keystroke a block put back is worth are in the runs as
    // keystrokes, so the silence before each of them is between two keystrokes.
    await t.test('an erase, an undo and a block of the document put back are keystrokes, and end one', () => {
        const line = 'if err != nil { return err }';
        const s = sensor({ text: `${line}\n${line}` });
        s.type('a');
        s.erase(3, { seconds: 1.6 });
        s.edit([], { seconds: 10, reason: 'undo' });
        s.edit([{ text: line, rangeLength: 0 }], { seconds: 2 });
        assert.deepEqual(s.runs, [['type', 1], ['gap', 1600], ['erase', 3], ['gap', 10_000], ['other', 1],
            ['undo', 1], ['gap', 2000], ['other', 1], ['self', chars(line)]]);
    });

    // Measuring suspended is not the writer being silent: nothing is counted while it lasts,
    // and the session that follows starts with no keystroke before it.
    await t.test('the time spent not measuring is not a silence', () => {
        const s = sensor();
        s.type('a');
        s.flush('pause');
        s.type('b', { seconds: 60 });
        assert.deepEqual(s.runs, [['type', 1]]);
    });

    await t.test('leaving the editor does not end the session: that silence is told', () => {
        const s = sensor();
        s.type('a');
        s.blur();
        s.comeBack({ seconds: 60 });
        s.type('b', { seconds: 1 });
        assert.deepEqual(s.runs, [['gap', 61_100], ['type', 1]]);
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
        const { window } = s.flush();
        assert.equal(window.flight.med, 125);
        assert.equal(window.flight.mad, 25);
    });

    await t.test('a completion accepted in one go does not enter the sample', () => {
        const s = sensor();
        s.type('a');
        s.type('func (s *Sensor) Measure(now int64) error {', { seconds: 0.1 });
        s.type('b', { seconds: 0.1 });
        // two keystrokes separated by an injection: a single flight time, hence no rhythm
        assert.equal(s.counters.flights.length, 1);
        assert.equal(s.flush().window.flight, undefined);
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
        const { window } = s.flushed[0];
        assert.equal(window.counts.exits, 1);
        assert.equal(window.why, 'away');
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
        const start = s.time.now + 100;
        s.type('a');
        s.type('b', { seconds: 4 });
        const { window } = s.flush();
        assert.equal(window.at, start);
        assert.equal(window.ms, 4000);
    });

    await t.test('lasts at least one second: a window of a single instant is sent as one', () => {
        const s = sensor();
        s.type('a');
        assert.equal(s.flush().window.ms, 1000);
    });

    await t.test('carries the size of the document, and its path stays beside it', () => {
        const s = sensor({ text: 'package main\n' });
        s.type('a');
        const item = s.flush();
        assert.equal(item.window.text.len, 12); // without the line break
        assert.equal(item.documentName, 'tp-go/src/main.go');
        assert.equal(item.documentId, 'vscode:abcd1234:src/main.go');
        assert.ok(!JSON.stringify(item.window).includes('main.go'), 'the window itself names no file');
    });

    await t.test('has the keys of the contract in its order, and no other', () => {
        const s = sensor();
        s.type('a');
        s.type('b');
        s.type('c');
        s.flush();
        s.type('d', { seconds: 5 });
        const { window } = s.flush();
        assert.deepEqual(Object.keys(window),
            ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'text', 'sum']);
        assert.deepEqual(Object.keys(s.flushed[0].window),
            ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'flight', 'text', 'sum']);
        assert.deepEqual(Object.keys(window.counts),
            ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars']);
        assert.deepEqual(Object.keys(s.flushed[0].window.flight), ['med', 'mad', 'bins']);
        assert.deepEqual(Object.keys(window.text), ['len', 'since', 'at', 'cut', 'add', 'kept']);
        assert.deepEqual(Object.keys(window.sum), ['keys', 'chars', 'pastes']);
    });

    // What the engine works out from the runs is not said a second time: a number sent twice
    // is a number that can disagree with itself.
    await t.test('repeats nothing the runs already say', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 5 });
        s.edit([{ text: 'x'.repeat(40), rangeLength: 0 }]);
        const sent = JSON.stringify(s.flush().window);
        for (const derived of ['keystrokes', 'paste_events', 'injected', 'self_paste', 'hesitations', 'pauses']) {
            assert.ok(!sent.includes(derived), derived);
        }
    });

    await t.test('goes out on its own after 200 keystrokes', () => {
        const s = sensor();
        for (let i = 0; i < 200; i++) s.type('a', { seconds: 0.05 });
        assert.equal(s.flushed.length, 1);
        assert.equal(s.flushed[0].window.why, 'volume');
        assert.deepEqual(plain(s.flushed[0].window.runs), [['type', 200, 199 * 50]]);
        assert.equal(s.flushed[0].window.sum.keys, 200);
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

test('what arrives in one block, and what arrives after a return', async (t) => {
    await t.test('each block is a run of its own, so the biggest is not hidden in a total', () => {
        // The size of one run is also the size of what was accepted in one gesture: a
        // completion, a block proposed by an assistant. Twenty blocks of a hundred characters
        // and one of two thousand must not read the same.
        const s = sensor();
        s.edit([{ text: 'x'.repeat(100), rangeLength: 0 }]);
        s.edit([{ text: 'y'.repeat(2000), rangeLength: 0 }]);
        s.edit([{ text: 'z'.repeat(40), rangeLength: 0 }]);
        assert.deepEqual(s.runs, [['paste', 100], ['paste', 2000], ['paste', 40]]);
        assert.equal(s.counters.injectedChars, 2140);
        assert.equal(s.counters.pastes, 3);
    });

    // The rule the four agents share: what arrives in one block is weighed in characters, never
    // in keystrokes. This agent never saw a key either, so it has always counted it that way.
    await t.test('an insertion made in one go is no keystroke at all', () => {
        const s = sensor();
        s.edit([{ text: 'w'.repeat(400), rangeLength: 0 }]);
        assert.equal(s.counters.injectedChars, 400);
        assert.equal(s.counters.keystrokes, 0);
    });

    await t.test('an insertion the size of a keystroke is typing, up to fifteen characters', () => {
        const s = sensor();
        s.type('a');
        s.type('x'.repeat(15));
        s.type('y'.repeat(16));
        assert.deepEqual(s.runs, [['type', 16], ['paste', 16]]);
        assert.equal(s.counters.injectedChars, 16);
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

// Deliberately the same cases as `browser/tests/sensor.test.mjs` and
// `libreoffice/tests/test_measure.py`: a divergence between the implementations shows up here
// first.
test('what is typed on returning', async (t) => {
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
        return s.flushed.at(-1).window.why;
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

    // A window always says why it closed: the engine refuses one that does not. A trigger the
    // table does not know is sealed with the word that claims the least, never with a word
    // outside the vocabulary.
    await t.test('a trigger the table does not know is sealed as `idle`', () => {
        assert.equal(sealedBy('something-new'), 'idle');
    });
});

// --- WHAT THE ENGINE READS A WINDOW BY ---
//
// A window says each thing once: the runs, and what only the sensor can classify. What follows
// is the engine's side of it, written out — every shape the contract refuses and every relation
// it verifies (docs/moteur.md), asserted on what the shipped sensor seals.

const KEYSTROKE_RUNS = ['type', 'erase', 'nav', 'other'];
const INSTANT_RUNS = ['move', 'click', 'paste', 'self', 'copy', 'undo', 'fix'];
const FLIGHT_EDGES = [0, 20, 40, 60, 80, 100, 130, 160, 200, 250, 320, 400, 500, 650];
const COUNT_KEYS = ['corrections', 'reformulations', 'revisions', 'jumps', 'exits', 'back_keys', 'back_chars'];
const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);
const whole = (value) => Number.isInteger(value) && value >= 0;

// What the engine derives from the runs of one window — the three figures the session's sums
// add up.
function derived(window) {
    const of = (...kinds) => window.runs.filter(([kind]) => kinds.includes(kind));
    return {
        keys: sum(of(...KEYSTROKE_RUNS).map(([, n]) => n)),
        chars: sum(of('paste').map(([, n]) => n).filter((n) => n > 15)),
        pastes: of('paste').length,
    };
}

// Everything the engine refuses or verifies on one window.
function assertCoherent(sealed) {
    const window = plain(sealed);
    const { runs } = window;
    const label = JSON.stringify(runs);

    // The keys of the contract, in its order; `flight` and `text` when there is one to send,
    // and never a `dwell`: no key is seen, so no release.
    assert.deepEqual(Object.keys(window), ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts',
        ...(window.flight ? ['flight'] : []), ...(window.text ? ['text'] : []), 'sum']);
    for (const key of ['seq', 'at', 'mono', 'ms', 'active']) assert.ok(whole(window[key]), `${key}: ${window[key]}`);
    assert.ok(window.ms >= 1000);
    assert.ok(['idle', 'volume', 'save', 'focus', 'away', 'end'].includes(window.why), window.why);
    assert.deepEqual(Object.keys(window.counts), COUNT_KEYS);
    assert.ok(Object.values(window.counts).every(whole), JSON.stringify(window.counts));

    // The runs: never none, 512 at most, each in the shape of its kind, whole numbers, and
    // never two neighbours of the same kind — a silence and a block excepted.
    assert.ok(runs.length > 0 && runs.length <= 512, `${runs.length} runs`);
    for (const [index, run] of runs.entries()) {
        const [kind, ...numbers] = run;
        if (kind === 'gap') assert.equal(numbers.length, 1, label);
        else if (KEYSTROKE_RUNS.includes(kind)) assert.equal(numbers.length, 2, label);
        else assert.ok(INSTANT_RUNS.includes(kind) && numbers.length === 1, label);
        assert.ok(numbers.every(whole), label);
        const previous = runs[index - 1];
        if (previous && previous[0] === kind) {
            assert.ok(['gap', 'paste', 'self'].includes(kind), `two ${kind} runs in a row: ${label}`);
        }
        // A silence is at least a second, and lies between two keystrokes: past the head of
        // the window, the keystroke that ends it is the very next run.
        if (kind === 'gap') {
            assert.ok(numbers[0] >= 1000, label);
            assert.ok(index < runs.length - 1, `a silence closes the window: ${label}`);
            if (index > 0) assert.ok(KEYSTROKE_RUNS.includes(runs[index + 1][0]), label);
        }
    }

    // What the runs last, the head silence aside, fits in the window.
    const body = runs[0][0] === 'gap' ? runs.slice(1) : runs;
    const lasting = body.map(([kind, n, ms]) => (kind === 'gap' ? n : ms || 0));
    assert.ok(sum(lasting) <= window.ms + 1000, `${label} in ${window.ms} ms`);

    if (window.flight) {
        const { med, mad, bins } = window.flight;
        assert.deepEqual(Object.keys(window.flight), ['med', 'mad', 'bins']);
        assert.ok(bins.length <= 14 && bins.every(whole) && bins.at(-1) !== 0, `${bins}`);
        assert.ok(sum(bins) >= 2, 'two flight times are a distribution');
        assert.ok(mad >= 0);
        // The median sent lies between the lower edge of the bin holding the lower-middle
        // flight time and the upper edge of the one holding the upper-middle: with an even
        // number of them it is the mean of the two, and may sit in an empty bin in between.
        const total = sum(bins);
        const binAt = (rank) => {
            let seen = 0;
            return bins.findIndex((count) => (seen += count) > rank);
        };
        const low = FLIGHT_EDGES[binAt(Math.floor((total - 1) / 2))];
        const high = [...FLIGHT_EDGES, 800][binAt(Math.floor(total / 2)) + 1];
        assert.ok(med >= low && med <= high, `${bins} / ${med}`);
    }

    // A window never holds less than itself in the session's sums.
    const own = derived(window);
    for (const key of ['keys', 'chars', 'pastes']) assert.ok(window.sum[key] >= own[key], key);
}

// The relations that tie the windows of one session together: the ranks, the sums, the spans.
// `entries` are queue entries, as the sensor hands them over.
function assertSession(entries) {
    const windows = entries.map((entry) => plain(entry.window));
    const running = { keys: 0, chars: 0, pastes: 0 };
    for (const [index, window] of windows.entries()) {
        assertCoherent(window);
        assert.equal(entries[index].session, entries[0].session);
        assert.equal(window.seq, index);
        const own = derived(window);
        for (const key of Object.keys(running)) running[key] += own[key];
        assert.deepEqual(window.sum, running);
        if (index === 0) {
            assert.notEqual(window.runs[0][0], 'gap', 'a silence never crosses a session');
            assert.deepEqual(window.text, { len: window.text.len }, 'a first reading has nothing to compare with');
            continue;
        }
        const { len, since, at, cut, add, kept } = window.text;
        assert.ok(since < window.seq);
        const before = windows[since].text.len;
        assert.equal(len, before - cut + add);
        assert.ok(at + cut <= before);
        assert.ok(at + add <= len);
        if (kept !== undefined) assert.ok(kept <= Math.min(cut, add));
    }
}

// A small deterministic generator: a scripted session must fail the same way twice.
function seeded(seed) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

const BLOCK = 'return errors.New("une réponse entièrement rédigée ailleurs")';

test('the runs, the sums and the spans hold together', async (t) => {
    await t.test('over a sitting: typing, a pause, moves, erasing, a block from elsewhere, one of its own', () => {
        const own = 'if err != nil { return fmt.Errorf("lecture: %w", err) }';
        const s = sensor({ text: `func read() error {\n\t${own}\n}` });
        let body = `func read() error {\n\t${own}\n}`;
        const hold = (next) => s.holds(body = next);

        for (const letter of 'func main') s.type(letter, { seconds: 0.15 });
        s.type('(', { seconds: 4 });                       // a silence
        s.type(')', { seconds: 1.5 });                     // a shorter one
        hold(body + 'func main()');
        s.flush('idle');

        s.move('mouse', false, { seconds: 6 });            // a click during the silence
        s.type('x', { seconds: 1 });
        s.erase(1);
        s.erase(1);
        s.move('keyboard', false, { seconds: 0.5, to: { line: 3, character: 0 } });
        hold(body + BLOCK);
        s.edit([{ text: BLOCK, rangeLength: 0 }]);          // brought from elsewhere
        hold(body + own);
        s.edit([{ text: own, rangeLength: 0 }]);            // the document's own text again
        s.edit([{ text: 'x', rangeLength: 0 }], { reason: 'undo' });
        s.flush('save');

        for (const letter of ' {}') s.type(letter, { seconds: 0.2 });
        s.erase(40, { seconds: 0.4 });                     // a block taken out
        hold(body.slice(0, -40));
        s.flush('idle');

        assert.equal(s.flushed.length, 3);
        assertSession(s.flushed);
        assert.deepEqual(plain(s.flushed[1].window.runs).map(([kind]) => kind),
            ['gap', 'click', 'type', 'erase', 'move', 'paste', 'other', 'self', 'other', 'undo']);
        assert.deepEqual(plain(s.flushed[0].window.runs),
            [['type', 9, 1200], ['gap', 4000], ['type', 1, 0], ['gap', 1500], ['type', 1, 0]]);
        assert.deepEqual(plain(s.flushed[2].window.sum), { keys: 20, chars: chars(BLOCK), pastes: 1 });
    });

    await t.test('a window of blocks only has no keystroke run, and no silence', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        s.holds(BLOCK);
        s.edit([{ text: BLOCK, rangeLength: 0 }], { seconds: 30 });
        s.holds(`${BLOCK}\nter ${BLOCK}`);
        s.edit([{ text: `ter ${BLOCK}`, rangeLength: 0 }], { seconds: 1 });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['paste', chars(BLOCK)], ['paste', chars(BLOCK) + 4]],
            'a block ends no silence');
        assert.deepEqual(plain(window.sum), { keys: 1, chars: 2 * chars(BLOCK) + 4, pastes: 2 });
        assert.equal(window.flight, undefined);
        assertSession(s.flushed);
    });

    await t.test('a silence ended by a click, then typing: the silence leads the window', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        s.move('mouse', false, { seconds: 20 });
        s.move('mouse', false, { seconds: 2 });
        s.type('b', { seconds: 1 });
        s.type('c', { seconds: 0.2 });
        const { window } = s.flush('idle');

        // The silence began before the window did: it is its first run, at its real length, and
        // the clicks made while it lasted take no time of their own.
        assert.deepEqual(plain(window.runs), [['gap', 23000], ['click', 2], ['type', 2, 200]]);
        assertSession(s.flushed);
    });

    await t.test('a silence opened by a block leads the window too, before the block', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        s.holds(BLOCK);
        s.edit([{ text: BLOCK, rangeLength: 0 }], { seconds: 5 });
        s.type('b', { seconds: 2 });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['gap', 7000], ['paste', chars(BLOCK)], ['type', 1, 0]]);
        assertSession(s.flushed);
    });

    await t.test('a silence of any length is told at its real length', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        s.type('b', { seconds: 400 });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['gap', 400_000], ['type', 1, 0]]);
        assertSession(s.flushed);
    });

    await t.test('the 200-keystroke ceiling seals a window whose runs add up to it', () => {
        const s = sensor();
        for (let i = 0; i < 450; i++) {
            if (i % 37 === 36) s.erase(1, { seconds: 0.05 });
            else s.type('e', { seconds: 0.05 });
        }
        s.flush('idle');

        assert.deepEqual(s.flushed.map((entry) => derived(plain(entry.window)).keys), [200, 200, 50]);
        assert.deepEqual(s.flushed.map((entry) => entry.window.why), ['volume', 'volume', 'idle']);
        assertSession(s.flushed);
    });

    await t.test('a window that holds 512 runs is sealed instead of growing past them', () => {
        const s = sensor();
        // Nothing here is a keystroke, so nothing else would ever seal this window.
        for (let i = 0; i < 700; i++) {
            s.move('mouse', false, { seconds: 0.2 });
            s.edit([{ text: BLOCK + i, rangeLength: 0 }], { seconds: 0.2 });
        }
        s.flush('idle');

        assert.deepEqual(s.flushed.map((entry) => entry.window.runs.length), [512, 512, 376]);
        assert.deepEqual(s.flushed.map((entry) => entry.window.why), ['volume', 'volume', 'idle']);
        assertSession(s.flushed);
    });

    // Caret moves and clicks alone wait for the next window — but not past what a window may
    // hold. At 512 runs they are sealed as they stand: no run is ever dropped to make room.
    await t.test('moves and clicks alone are sealed too when they fill a window, never cut', () => {
        const s = sensor();
        for (let i = 0; i < 600; i++) {
            s.move('mouse', false);
            s.move('keyboard', false);
        }
        assert.equal(s.flush('idle'), null, 'what is left waits, as moves alone always did');
        s.type('a');
        s.flush('idle');

        assert.deepEqual(s.flushed.map((entry) => entry.window.runs.length), [512, 512, 177]);
        assert.deepEqual(s.flushed.map((entry) => entry.window.why), ['volume', 'volume', 'idle']);
        assert.deepEqual(s.flushed.map((entry) => entry.window.counts.jumps), [512, 512, 176]);
        assert.deepEqual(plain(s.flushed[1].window.sum), { keys: 0, chars: 0, pastes: 0 });
        assertSession(s.flushed);
    });

    await t.test('a silence is never sealed apart from the keystroke that ends it', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        // 511 runs, and no keystroke among them: one more would fit, a silence and its
        // keystroke would not.
        for (let i = 0; i < 255; i++) {
            s.move('mouse', false);
            s.edit([{ text: BLOCK + i, rangeLength: 0 }]);
        }
        s.move('mouse', false);
        s.type('b');
        s.flush('idle');

        assert.equal(s.flushed[1].window.runs.length, 511);
        assert.equal(s.flushed[1].window.why, 'volume');
        assert.deepEqual(plain(s.flushed[2].window.runs).map(([kind]) => kind), ['gap', 'type']);
        assertSession(s.flushed);
    });

    await t.test('whatever the gestures and their order', () => {
        // Not a case but a thousand of them: the relations are claimed for every window, so they
        // are asked of windows nobody chose.
        for (let seed = 1; seed <= 40; seed++) {
            const random = seeded(seed);
            const s = sensor();
            let body = 'package main';
            const pick = (...choices) => choices[Math.floor(random() * choices.length)];
            for (let step = 0; step < 400; step++) {
                const seconds = pick(0.03, 0.1, 0.1, 0.3, 0.9, 1.2, 2.5, 3.5, 7, 70, 310);
                const gesture = random();
                if (gesture < 0.45) {
                    body += 'e';
                    s.holds(body);
                    s.type('e', { seconds });
                } else if (gesture < 0.6) {
                    s.erase(pick(1, 1, 3, 8, 30), { seconds });
                } else if (gesture < 0.7) {
                    s.move(pick('mouse', 'keyboard', 'command'), random() < 0.3, { seconds });
                } else if (gesture < 0.78) {
                    const block = `${BLOCK} ${step}`;
                    body += block;
                    s.holds(body);
                    s.edit([{ text: block, rangeLength: pick(0, 0, 12) }], { seconds });
                } else if (gesture < 0.84) {
                    body += BLOCK;
                    s.holds(body);
                    s.edit([{ text: BLOCK, rangeLength: pick(0, 0, 4) }], { seconds });
                } else if (gesture < 0.9) {
                    s.edit([{ text: 'x', rangeLength: 0 }], { seconds, reason: pick('undo', 'undo', 'redo') });
                } else if (gesture < 0.94) {
                    s.edit([{ text: 'ab', rangeLength: 3 }], { seconds });
                } else if (gesture < 0.97) {
                    s.blur();
                    s.comeBack({ seconds });
                } else {
                    s.flush(pick('idle', 'save', 'manual'));
                }
            }
            s.flush('idle');
            assert.ok(s.flushed.length > 3, `seed ${seed}`);
            assertSession(s.flushed);
        }
    });
});

test('what a run is made of', async (t) => {
    await t.test('a run of typing never ends on a character', () => {
        // Not on a space, not on a comma, not on a line break: the length of the words would be
        // readable in the runs otherwise, and the runs leave the machine.
        const s = sensor();
        const written = 'if x, ok := m[k]; ok {\n\treturn x\n}';
        for (const letter of written) s.type(letter, { seconds: 0.12 });
        const { window } = s.flush('idle');

        assert.equal(window.runs.length, 1);
        assert.deepEqual(plain(window.runs[0]).slice(0, 2), ['type', written.length]);
    });

    await t.test('and carries a kind and numbers, nothing of what was written', () => {
        const s = sensor();
        s.holds(`secret ${BLOCK}`);
        for (const letter of 'secret') s.type(letter);
        s.edit([{ text: BLOCK, rangeLength: 0 }]);
        const item = s.flush('idle');

        const sent = JSON.stringify({ ...item, documentName: '', documentId: '' });
        assert.ok(!sent.includes('secret') && !sent.includes('errors'), sent);
        for (const [kind, ...numbers] of item.window.runs) {
            assert.equal(typeof kind, 'string');
            assert.ok(numbers.every((n) => typeof n === 'number'));
        }
    });

    await t.test('a move made at the keyboard is a `move`, a click a `click`, and neither is a keystroke', () => {
        // Not a `nav`: a run of that kind is made of counted keystrokes, and a caret move is not
        // one here — the editor says where the caret went, never that a key sent it. Neither
        // has a duration: both fall inside silences, which already tell that time.
        const s = sensor();
        s.type('a');
        s.move('keyboard', false, { to: { line: 0, character: 0 } });
        s.move('keyboard', false, { to: { line: 1, character: 0 } });
        s.move('command', false);
        s.move('mouse', false);
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['type', 1, 0], ['move', 2], ['click', 1]]);
        assert.equal(window.counts.jumps, 4, 'a move a command made is a jump, and no run');
        assert.equal(window.sum.keys, 1);
    });

    await t.test('an undo is a keystroke and an undo; a redo is the keystroke alone', () => {
        const s = sensor();
        s.edit([{ text: 'x', rangeLength: 0 }], { reason: 'undo' });
        s.edit([{ text: 'x', rangeLength: 0 }], { reason: 'redo' });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['other', 1, 0], ['undo', 1], ['other', 1, 0]]);
        assert.equal(window.sum.keys, 2);
    });

    await t.test('clicks alone wait for the next window, without the time they took', () => {
        const s = sensor();
        s.move('mouse', false);
        s.move('mouse', false, { seconds: 1 });
        assert.equal(s.flush('idle'), null);
        s.move('mouse', false, { seconds: 600 });
        s.type('a', { seconds: 0.5 });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.runs), [['click', 3], ['type', 1, 0]]);
        assert.equal(window.ms, 1000, 'the window opens at the click that precedes the typing');
        assertCoherent(window);
    });
});

test('the distribution of the rhythm', async (t) => {
    await t.test('fourteen bins on the edges of the contract, the last one closed at 800 ms', () => {
        assert.equal(FLIGHT_EDGES.length, 14);
        const s = sensor();
        s.type('a');
        for (const ms of [0, 19, 20, 99, 100, 129, 130, 649, 650, 799, 800, 999]) s.type('a', { seconds: ms / 1000 });
        const { window } = s.flush('idle');

        //                                    0  20 40 60 80 100 130 160 200 250 320 400 500 650
        assert.deepEqual(plain(window.flight.bins), [2, 1, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 1, 2]);
        assert.equal(sum(window.flight.bins), 10, '800 ms and more is not a flight time');
    });

    await t.test('the empty bins at the end are not sent', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 0.03 });
        s.type('c', { seconds: 0.05 });
        s.type('d', { seconds: 0.05 });
        const { window } = s.flush('idle');

        assert.deepEqual(plain(window.flight), { med: 50, mad: 0, bins: [0, 1, 2] });
        assertCoherent(window);
    });

    await t.test('fewer than two flight times: no distribution, as there is no median', () => {
        const s = sensor();
        s.type('a');
        s.type('b');
        const { window } = s.flush('idle');

        assert.equal(window.flight, undefined);
    });

    await t.test('two flight times far apart are still a distribution', () => {
        // Their median is the mean of the two and sits in a bin that holds nothing: the engine
        // reads it between the two bins, so the histogram is sent as it is.
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 0.03 });
        s.type('c', { seconds: 0.7 });
        const { window } = s.flush('idle');

        assert.equal(window.flight.med, 365);
        assert.deepEqual(plain(window.flight.bins), [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assertCoherent(window);
    });

    await t.test('a block that lands in one shot is not in it', () => {
        const s = sensor();
        for (const letter of 'abc') s.type(letter);
        s.edit([{ text: BLOCK, rangeLength: 0 }], { seconds: 0.01 });
        const { window } = s.flush('idle');

        assert.equal(sum(window.flight.bins), 2);
    });
});

test('how far the text moved since the previous reading', async (t) => {
    const reading = (s, text) => {
        s.holds(text);
        s.type('a', { seconds: 5 });
        return s.flush('idle').window;
    };

    await t.test('the first reading of a session is the size alone', () => {
        const s = sensor({ text: 'func main() {\n}\n' });
        s.type('a');

        assert.deepEqual(plain(s.flush('idle').window.text), { len: 14 });
    });

    await t.test('lengths: where it starts, what went, what came', () => {
        const s = sensor({ text: 'func main() {\n}\n' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'func main() {\n\tfmt.Println("x")\n}\n');

        // Counted as the size is: in characters, line breaks left out.
        assert.deepEqual(plain(window.text), { len: 31, since: 0, at: 13, cut: 0, add: 17, kept: 0 });
    });

    await t.test('a replacement of the same length shows, where the size alone says nothing', () => {
        const s = sensor({ text: 'un paragraphe écrit à la main, puis la suite' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'un PARAGRAPHE REMIS par autre, puis la suite');

        assert.deepEqual(plain(window.text), { len: 44, since: 0, at: 3, cut: 26, add: 26, kept: 0 });
        assert.equal(window.text.len, s.flushed[0].window.text.len);
    });

    await t.test('an unchanged text is said too: nothing went, nothing came', () => {
        const s = sensor({ text: 'du code' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'du code');

        assert.deepEqual(plain(window.text), { len: 7, since: 0, at: 7, cut: 0, add: 0, kept: 0 });
    });

    await t.test('a character outside the basic plane is one character, never cut in two', () => {
        // Two emoji that share their first half: a cut between the halves would count it twice.
        const s = sensor({ text: 'a😀b' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'a😁b');

        assert.deepEqual(plain(window.text), { len: 3, since: 0, at: 1, cut: 1, add: 1, kept: 0 });
        assertSession(s.flushed);
    });

    await t.test('two edits far apart: what stood untouched between them is kept, not new', () => {
        // A span is a hull. Its `add` holds the whole stretch between the first edit and the
        // last, and only `kept` says that stretch was already there.
        const middle = 'x := lire(chemin)\n\tif err != nil {\n\t\treturn err\n\t}\n';
        const s = sensor({ text: `a ${middle}z` });
        s.type('a');
        s.flush('idle');
        const window = reading(s, `premier ${middle}dernier`);

        const { cut, add, kept } = window.text;
        assert.equal(cut, chars(`a ${middle}z`));
        assert.equal(add, chars(`premier ${middle}dernier`));
        // Every word of the middle and the spacing that follows each of them.
        assert.equal(kept, chars(middle));
        assert.equal(add - kept, chars('premier dernier'));
    });

    await t.test('a text replaced by another of the same size keeps nothing', () => {
        const s = sensor({ text: 'début un paragraphe écrit à la main fin' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'début des phrases venues toutes faites fin');

        assert.equal(window.text.kept, 0);
    });

    await t.test('words that moved are kept only in the order they were in', () => {
        const s = sensor({ text: 'début alpha beta gamma delto fin' });
        s.type('a');
        s.flush('idle');
        const window = reading(s, 'début delto alpha beta gamma fin');

        // 'alpha beta gamma' with the two spaces between them; 'delto' changed side.
        assert.equal(window.text.kept, 16);
    });

    await t.test('past 2 000 words on either side nothing is looked for, and nothing is claimed', () => {
        const long = Array.from({ length: 2001 }, (_, i) => `mot${i}`).join(' ');
        const s = sensor({ text: `a ${long} z` });
        s.type('a');
        s.flush('idle');
        const window = reading(s, `b ${long} y`);

        assert.deepEqual(Object.keys(window.text), ['len', 'since', 'at', 'cut', 'add']);
        const shorter = long.split(' ').slice(0, 1990).join(' ');
        reading(s, `c ${shorter} x`);
        const under = reading(s, `d ${shorter} w`);
        assert.equal(under.text.kept, chars(`${shorter} `), 'under the bound it is');
        assertSession(s.flushed);
    });

    await t.test('on a long text, wherever the edit falls', () => {
        // The comparison goes block by block before it goes unit by unit: what it finds must be
        // what a character-by-character reading finds, on either side of a block's edge and
        // with characters that take two units.
        const naive = (before, after) => {
            const [a, b] = [[...before], [...after]];
            let head = 0;
            while (head < Math.min(a.length, b.length) && a[head] === b[head]) head++;
            let tail = 0;
            while (tail < Math.min(a.length, b.length) - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
            return { at: head, cut: a.length - head - tail, add: b.length - head - tail };
        };
        const random = seeded(7);
        let text = Array.from({ length: 5000 }, (_, i) => (i % 97 === 0 ? '😀' : String.fromCharCode(97 + (i * 7) % 26))).join('');
        const s = sensor({ text });
        s.type('a');
        s.flush('idle');
        for (let round = 0; round < 60; round++) {
            const at = Math.floor(random() * [...text].length);
            const cut = Math.floor(random() * 40);
            const put = '😁xyz'.repeat(Math.floor(random() * 30)).slice(0, Math.floor(random() * 90));
            const next = [...[...text].slice(0, at), ...put, ...[...text].slice(at + cut)].join('');
            const window = reading(s, next);
            const { len, since, kept, ...span } = plain(window.text);
            assert.ok(kept <= Math.min(span.cut, span.add));
            assert.equal(since, round);
            assert.equal(len, [...next].length);
            assert.deepEqual(span, naive(text, next), `round ${round}`);
            text = next;
        }
        assertSession(s.flushed);
    });

    await t.test('the document is read once per sealed window, for the size and the span alike', () => {
        const s = sensor();
        for (const letter of 'abc') s.type(letter);
        assert.equal(s.reads.text, 0);
        s.flush('idle');
        assert.equal(s.reads.text, 1);
    });

    await t.test('the reading kept for the comparison is released when measuring stops', () => {
        const s = sensor();
        s.type('a');
        s.flush('idle');
        assert.equal(typeof s.instance.reading.body, 'string');
        s.type('b');
        s.flush('pause');

        assert.equal(s.instance.reading, null);
    });

    const bare = (volume) => {
        const flushed = [];
        const time = clock();
        const instance = new Sensor({ documentId: 'd', documentName: 'n', volume, flushed: (w) => flushed.push(w) });
        instance.change([{ text: 'a', rangeLength: 0 }], '', time.advance(1));
        instance.flush('idle');
        instance.change([{ text: 'b', rangeLength: 0 }], '', time.advance(1));
        instance.flush('idle');
        return flushed;
    };

    await t.test('a host that hands over a count and no text sends the size alone, every time', () => {
        assert.deepEqual(bare(() => 7).map((entry) => plain(entry.window.text)), [{ len: 7 }, { len: 7 }]);
    });

    // Absent, never zero: a size of 0 would say the document is empty.
    await t.test('a text that could not be read is not described at all', () => {
        const flushed = bare(() => null);

        assert.equal(flushed[1].window.text, undefined);
        assert.deepEqual(Object.keys(flushed[1].window), ['seq', 'at', 'mono', 'ms', 'why', 'active', 'runs', 'counts', 'sum']);
    });
});

test('a session, its ranks and its sums', async (t) => {
    await t.test('a window is numbered when it is sealed, whether or not it ever leaves', () => {
        // The sensor knows nothing of the network: the rank and the sums are its own, so a
        // window that is held back downstream is missing from a sequence that says so.
        const s = sensor();
        for (let window = 0; window < 4; window++) {
            s.holds('x'.repeat(window) + BLOCK);
            s.type('ab', { seconds: 5 });
            s.edit([{ text: BLOCK, rangeLength: 0 }]);
            s.flush('idle');
        }
        const windows = s.flushed.map((entry) => plain(entry.window));
        const received = windows.filter((w) => w.seq !== 2);

        assert.deepEqual(received.map((w) => w.seq), [0, 1, 3]);
        // What is missing from the sums is exactly what the withheld window carried.
        const withheld = derived(windows[2]);
        assert.deepEqual(withheld, { keys: 2, chars: chars(BLOCK), pastes: 1 });
        for (const key of ['keys', 'chars', 'pastes']) {
            assert.equal(received.at(-1).sum[key] - sum(received.map((w) => derived(w)[key])), withheld[key], key);
        }
    });

    await t.test('the session is named when measuring starts, and renamed when it starts again', () => {
        const s = sensor();
        assert.equal(s.sessions.opened, 0, 'a sensor that measured nothing drew nothing');
        s.type('a');
        s.flush('save');
        s.type('b');
        s.flush('blur');
        s.type('c');
        s.flush('pause');                                   // measuring suspended
        s.type('d', { seconds: 60 });
        s.flush('logout');                                  // the account signed out
        s.type('e', { seconds: 60 });
        s.flush('idle');

        const names = s.flushed.map((entry) => entry.session);
        assert.deepEqual(names, [names[0], names[0], names[0], names[3], names[4]]);
        assert.equal(new Set(names).size, 3);
        assert.deepEqual(s.flushed.map((entry) => entry.window.seq), [0, 1, 2, 0, 0]);
        assert.deepEqual(s.flushed.map((entry) => entry.window.sum.keys), [1, 2, 3, 1, 1]);
        assert.deepEqual(Object.keys(s.flushed[3].window.text), ['len'], 'a new session has no previous reading');
        assert.deepEqual(s.flushed.map((entry) => entry.window.mono), [0, 100, 200, 0, 0],
            'and its monotonic clock starts again at its first event');
    });

    await t.test('the monotonic clock counts from the start of the session', () => {
        const s = sensor();
        s.type('a');
        s.type('b', { seconds: 1.5 });
        s.flush('idle');
        s.type('c', { seconds: 10 });
        const first = s.flushed[0].window;
        const second = s.flush('idle').window;

        assert.deepEqual([first.mono, first.ms], [0, 1500]);
        assert.deepEqual([second.mono, second.ms], [11500, 1000], 'a window lasts a second at least');
        // The same instants on the wall clock: the two move together unless one is tampered with.
        assert.equal(second.at - first.at, second.mono - first.mono);
    });

    // Every duration is read on the monotonic clock; the wall clock only dates a window. So a
    // wall clock set back or forward in the middle of a sitting moves `at`, and nothing else.
    await t.test('a wall clock that jumps moves no duration', () => {
        const session = (jump) => {
            const flushed = [];
            let wall = 1_800_000_000_000;
            let mono = 5000;
            const instance = new Sensor({
                documentId: 'd', documentName: 'n', text: () => 'du code',
                newSession: () => 'session-00000000000001',
                monotonic: () => mono,
                flushed: (entry) => flushed.push(plain(entry.window)),
            });
            const type = (ms) => {
                wall += ms;
                mono += ms;
                instance.change([{ text: 'a', rangeLength: 0 }], '', wall);
            };
            type(0);
            type(150);
            type(150);
            instance.flush('idle');
            wall += jump;                                   // the student sets the clock
            type(4000);
            type(200);
            instance.blur();
            mono += 2000;
            wall += 2000;
            instance.focus();
            type(1000);
            instance.flush('idle');
            return flushed;
        };
        const straight = session(0);

        for (const jump of [-3_600_000, 3_600_000]) {
            const jumped = session(jump);
            const undated = (windows) => windows.map((window) => ({ ...window, at: 0 }));
            assert.deepEqual(undated(jumped), undated(straight), `${jump}`);
            assert.deepEqual(jumped.map((w, i) => w.at - straight[i].at), [0, jump, jump]);
        }
        assert.deepEqual(straight[1].runs, [['gap', 4000], ['type', 2, 200]]);
        assert.deepEqual(straight[2], { ...straight[2], mono: 7500, ms: 1000, runs: [['gap', 3000], ['type', 1, 0]] });
        assert.equal(straight[2].counts.back_keys, 1, 'the seconds after a return are counted on it too');
    });

    await t.test('the limits the engine holds are the ones declared here', () => {
        const { TIMELINE_MAX_RUNS, FLIGHT_BINS_MS, SESSION_ID_BYTES } = sensorModule();

        assert.equal(TIMELINE_MAX_RUNS, 512);
        assert.deepEqual([...FLIGHT_BINS_MS], FLIGHT_EDGES);
        assert.ok(SESSION_ID_BYTES * 8 >= 96);
    });
});
