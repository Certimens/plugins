// The offline queue's file (src/queue-file.js), against a real temporary folder.
//
// What it must hold: appending costs a line whatever waits before it, a send writes the cursor
// and nothing else, a crash mid-append costs the window being appended and nothing more — and,
// stopped between **any** two of its writes, the queue read back may send a window again but
// never skips one. That last property is checked by stopping a scenario at each write in turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { FileQueue, QUEUE_FILE, CURSOR_FILE } = require('../src/queue-file.js');

async function folder(t) {
    const dir = await mkdtemp(join(tmpdir(), 'certimens-queue-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

const ids = (items) => items.map((item) => item.id);
const lines = async (dir) => (await readFile(join(dir, QUEUE_FILE), 'utf8')).split('\n').filter(Boolean).length;
const cursor = async (dir) => readFile(join(dir, CURSOR_FILE), 'utf8').catch(() => '');

// The file system, counting what it writes: the calls a crash can fall between.
const WRITES = ['writeFile', 'appendFile', 'rename', 'truncate'];

function counting() {
    const counts = Object.fromEntries(WRITES.map((name) => [name, 0]));
    const fs = { ...realFs };
    for (const name of WRITES) {
        fs[name] = (...args) => {
            counts[name]++;
            return realFs[name](...args);
        };
    }
    return { fs, counts };
}

// A file system that dies at its `at`-th write. With `torn`, a write in progress leaves half its
// bytes on disk, the way a power cut can; without, it leaves nothing. A rename or a truncation
// does not happen. Nothing after it happens either — the process is gone.
function crashing(at, { torn = true } = {}) {
    let writes = 0;
    const fs = { ...realFs };
    for (const name of WRITES) {
        fs[name] = async (...args) => {
            writes++;
            if (writes < at) return realFs[name](...args);
            if (torn && writes === at && (name === 'writeFile' || name === 'appendFile')) {
                const data = Buffer.from(String(args[1]));
                await realFs[name](args[0], data.subarray(0, Math.floor(data.length / 2)));
            }
            throw new Error('crash');
        };
    }
    return { fs, writes: () => writes };
}

test('the queue file', async (t) => {
    await t.test('appends, advances and is read back from its cursor after a restart', async (t) => {
        const dir = await folder(t);
        const queue = new FileQueue(join(dir, 'nested', 'storage'));
        assert.deepEqual(await queue.load(), [], 'a folder that does not exist yet is created');
        for (const id of [1, 2, 3, 4]) await queue.append({ id });
        await queue.advance(1);
        await queue.advance(2);

        const again = new FileQueue(join(dir, 'nested', 'storage'));
        assert.deepEqual(ids(await again.load()), [4]);
        await again.append({ id: 5 });
        assert.deepEqual(ids(await new FileQueue(join(dir, 'nested', 'storage')).load()), [4, 5]);
    });

    await t.test('an append writes one line and a send one cursor, whatever waits', async (t) => {
        const dir = await folder(t);
        const { fs, counts } = counting();
        const queue = new FileQueue(dir, { fs });
        await queue.load();
        for (let id = 0; id < 1000; id++) await queue.append({ id });
        await queue.advance(10);
        assert.deepEqual(counts, { writeFile: 1, appendFile: 1000, rename: 0, truncate: 0 });
        assert.equal(await cursor(dir), '10');
        assert.equal(await lines(dir), 1000, 'nothing is compacted for a send');
    });

    await t.test('a last line cut short by a crash is skipped, and cut off before the next append', async (t) => {
        const dir = await folder(t);
        await writeFile(join(dir, QUEUE_FILE), '{"id":1}\n{"id":2}\n{"id":3,"wi');
        await writeFile(join(dir, CURSOR_FILE), '1');
        const queue = new FileQueue(dir);
        assert.deepEqual(ids(await queue.load()), [2]);
        await queue.append({ id: 4 });
        assert.equal(await readFile(join(dir, QUEUE_FILE), 'utf8'), '{"id":1}\n{"id":2}\n{"id":4}\n');
        assert.deepEqual(ids(await new FileQueue(dir).load()), [2, 4]);
    });

    await t.test('a line that does not parse is dropped, and the file compacted around it', async (t) => {
        const dir = await folder(t);
        await writeFile(join(dir, QUEUE_FILE), '{"id":1}\nnot json\n{"id":3}\n');
        const queue = new FileQueue(dir);
        assert.deepEqual(ids(await queue.load()), [1, 3]);
        assert.equal(await lines(dir), 2);
        await queue.advance(1);
        assert.deepEqual(ids(await new FileQueue(dir).load()), [3]);
    });

    await t.test('a cursor past the end reads from the start: it may resend, never skip', async (t) => {
        const dir = await folder(t);
        await writeFile(join(dir, QUEUE_FILE), '{"id":1}\n');
        await writeFile(join(dir, CURSOR_FILE), '7');
        const queue = new FileQueue(dir);
        assert.deepEqual(ids(await queue.load()), [1]);
        for (const id of [2, 3, 4, 5, 6, 7, 8, 9]) await queue.append({ id });
        assert.equal(await cursor(dir), '0', 'written at once, before the file grows under it');
    });

    await t.test('compacts only when told: emptied, or rewritten', async (t) => {
        const dir = await folder(t);
        const queue = new FileQueue(dir);
        await queue.load();
        for (const id of [1, 2, 3]) await queue.append({ id });
        await queue.advance(1);
        await queue.rewrite([{ id: 3 }]);
        assert.equal(await lines(dir), 1);
        assert.equal(await cursor(dir), '0');
        assert.deepEqual(ids(await new FileQueue(dir).load()), [3]);
        await queue.rewrite([]);
        assert.equal(await readFile(join(dir, QUEUE_FILE), 'utf8'), '');
        assert.deepEqual(await new FileQueue(dir).load(), []);
    });

    await t.test('cleared without having been read: a sign-out in a window that never loaded it', async (t) => {
        const dir = await folder(t);
        await writeFile(join(dir, QUEUE_FILE), '{"id":1}\n{"id":2}\n');
        await writeFile(join(dir, CURSOR_FILE), '1');
        await new FileQueue(dir).clear();
        assert.deepEqual(await new FileQueue(dir).load(), []);
        assert.equal(await cursor(dir), '0');
    });

    await t.test('an append that fails leaves no fragment for the next one to be glued to', async (t) => {
        const dir = await folder(t);
        const { fs } = crashing(Infinity);
        let fail = false;
        fs.appendFile = async (file, data) => {
            if (!fail) return realFs.appendFile(file, data);
            await realFs.appendFile(file, String(data).slice(0, 5));
            throw new Error('disk full');
        };
        const queue = new FileQueue(dir, { fs });
        await queue.load();
        await queue.append({ id: 1 });
        fail = true;
        await assert.rejects(queue.append({ id: 2 }), /disk full/);
        fail = false;
        await queue.append({ id: 3 });
        assert.deepEqual(ids(await new FileQueue(dir).load()), [1, 3]);
    });
});

// A day of the queue: windows appended, sends, a full queue that gives up its oldest, a renamed
// file, a catch-up that empties it. `model` is what must still be waiting after each step.
const SCENARIO = [
    ['append', 1], ['append', 2], ['append', 3],
    ['advance', 1], ['append', 4], ['advance', 2], ['append', 5],
    ['evict'], ['append', 6], ['advance', 1],
    ['rename'], ['append', 7], ['advance', 1],
    ['empty'], ['append', 8],
];

async function play(queue, model, step) {
    const [op, arg] = step;
    if (op === 'append') {
        await queue.append({ id: arg });
        return [...model, { id: arg }];
    }
    if (op === 'advance') {
        await queue.advance(arg);
        return model.slice(arg);
    }
    const next = op === 'evict' ? model.slice(1)
        : op === 'rename' ? model.map((item) => ({ ...item, renamed: true }))
            : [];
    await queue.rewrite(next);
    return next;
}

test('stopped between any two writes, the queue resends at worst and never skips', async (t) => {
    // How many writes the whole scenario makes, run once to the end.
    const dir = await folder(t);
    const { fs, writes } = crashing(Infinity);
    const full = new FileQueue(dir, { fs });
    await full.load();
    let model = [];
    for (const step of SCENARIO) model = await play(full, model, step);
    assert.deepEqual(ids(await new FileQueue(dir).load()), [8]);
    const total = writes();
    assert.ok(total > SCENARIO.length, `${total} writes`);

    for (let run = 0; run < total * 2; run++) {
        const at = (run % total) + 1;
        const torn = run < total;
        const here = await folder(t);
        const queue = new FileQueue(here, { fs: crashing(at, { torn }).fs });
        await queue.load();
        let before = [];
        let failed = null;
        for (const step of SCENARIO) {
            try {
                before = await play(queue, before, step);
            } catch {
                failed = step;
                break;
            }
        }
        assert.ok(failed, `write ${at} was reached`);
        // What the step that died would have kept, of what was waiting before it: a rewrite
        // may give up windows (it was asked to), nothing else may lose any.
        const kept = failed[0] === 'evict' ? before.slice(1) : failed[0] === 'empty' ? [] : before;

        const read = await new FileQueue(here).load();
        const found = new Set(ids(read));
        for (const id of ids(kept)) assert.ok(found.has(id), `crash at write ${at}${torn ? ' (torn)' : ''} (${failed.join(' ')}): window ${id} skipped — read ${JSON.stringify(ids(read))}`);
        // Nothing that was never written, nothing twice, and in the order of the queue.
        assert.deepEqual(ids(read), [...ids(read)].sort((a, b) => a - b), `crash at write ${at}${torn ? ' (torn)' : ''}: order`);
        assert.equal(found.size, read.length, `crash at write ${at}${torn ? ' (torn)' : ''}: a window read twice`);

        // And the queue carries on from there.
        const after = new FileQueue(here);
        await after.load();
        await after.append({ id: 99 });
        assert.deepEqual(ids(await new FileQueue(here).load()), [...ids(read), 99], `crash at write ${at}${torn ? ' (torn)' : ''}: the next append`);
    }
});
