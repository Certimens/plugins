// Certimens — VS Code extension: the offline queue, kept in a file of its own under the
// workspace's storage folder (`context.storageUri`).
//
// The editor's workspace state is a Memento, and a Memento serialises its whole content on every
// write: with thousands of windows waiting after a long outage, each sealed window rewrote
// megabytes, several times. Here the queue is two files:
//
//   queue.jsonl  one window per line, JSON, each line ended by "\n" — only ever appended to,
//                except when it is compacted (see `rewrite`);
//   queue.sent   how many lines at its head have already left, as a decimal number.
//
// Appending a window writes one line, whatever is queued behind it; a send writes the cursor, a
// few bytes. The file is rewritten only when everything has left (it is emptied) or when the
// queue is full and its oldest windows are given up, or when a renamed file renames the windows
// waiting for it.
//
// **Stopped between any two writes, the queue may send a window again, never skip one.** The
// engine takes a window it already holds for the resend it is; a window skipped is a window lost.
// Every order below follows from that.
//
// A window of the editor is the only one to open its workspace, so these files have one writer
// and no lock. The engine client calls every method under its own lock, one at a time.

const nodeFs = require('node:fs/promises');
const path = require('node:path');

const QUEUE_FILE = 'queue.jsonl';
const CURSOR_FILE = 'queue.sent';

// What a cursor file reads as. A cursor torn by a crash is a prefix of the number that was being
// written — a smaller number, so windows go again rather than being skipped — and an empty or
// unreadable one is zero.
function cursorOf(text) {
    const value = Number.parseInt(text, 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const lineOf = (item) => JSON.stringify(item) + '\n';

class FileQueue {
    /**
     * @param {string} dir the folder the two files live in, created if missing.
     * @param {{fs?: typeof nodeFs}} [options] `fs` is the tests' seam: a file system that stops
     *   in the middle of a write is how a crash is simulated.
     */
    constructor(dir, { fs = nodeFs } = {}) {
        this.fs = fs;
        this.dir = dir;
        this.file = path.join(dir, QUEUE_FILE);
        this.cursorFile = path.join(dir, CURSOR_FILE);
        // What is on disk, as this object last left it: complete lines, bytes, and the cursor.
        // The cursor is null until read — unknown, so the next compaction writes it.
        this.lines = 0;
        this.size = 0;
        /** @type {number | null} */
        this.cursor = null;
        /** @type {Promise<unknown> | null} */
        this.folder = null;
    }

    ensureFolder() {
        if (!this.folder) this.folder = this.fs.mkdir(this.dir, { recursive: true }).catch((err) => {
            this.folder = null;
            throw err;
        });
        return this.folder;
    }

    async readOr(file, fallback) {
        try {
            return await this.fs.readFile(file);
        } catch (err) {
            if (err && err.code === 'ENOENT') return fallback;
            throw err;
        }
    }

    /**
     * The windows still waiting, oldest first. Reads the whole file once, at start.
     *
     * A last line without its "\n" is a window whose append was cut short: it was never
     * acknowledged, so never sent, and it is cut off the file — appended to as it is, the next
     * window would be glued to it. A complete line that does not parse (nothing writes one) is
     * dropped, and the file is compacted so that lines and windows count alike again.
     * @returns {Promise<object[]>}
     */
    async load() {
        await this.ensureFolder();
        const bytes = await this.readOr(this.file, Buffer.alloc(0));
        let cursor = cursorOf(String(await this.readOr(this.cursorFile, '')));
        const lines = bytes.toString('utf8').split('\n');
        const torn = lines.pop();
        // A cursor past the end can only come from a file changed behind our back: read from
        // the start, which may resend, rather than trust it — and written at once, before an
        // append grows the file under it and makes it skip.
        if (cursor > lines.length) {
            cursor = 0;
            await this.fs.writeFile(this.cursorFile, '0');
        }
        this.cursor = cursor;
        const items = [];
        let damaged = false;
        for (let i = cursor; i < lines.length; i++) {
            try {
                items.push(JSON.parse(lines[i]));
            } catch (_) {
                damaged = true;
            }
        }
        if (damaged) {
            // What is on disk, so that a rewrite to nothing knows there is something to empty.
            this.size = bytes.length;
            await this.rewrite(items);
            return items;
        }
        this.lines = lines.length;
        this.size = bytes.length - Buffer.byteLength(torn);
        if (torn) await this.fs.truncate(this.file, this.size);
        return items;
    }

    /** One window at the tail: a line written, whatever is queued before it. */
    async append(item) {
        const line = lineOf(item);
        try {
            await this.fs.appendFile(this.file, line);
        } catch (err) {
            // A write that failed half-way leaves a fragment the next line would be glued to.
            await this.fs.truncate(this.file, this.size).catch(() => {});
            throw err;
        }
        this.size += Buffer.byteLength(line);
        this.lines++;
    }

    /** `count` more windows at the head have left: the cursor moves, nothing else is written. */
    async advance(count) {
        const cursor = (this.cursor || 0) + count;
        await this.fs.writeFile(this.cursorFile, String(cursor));
        this.cursor = cursor;
    }

    /**
     * Replaces what is waiting with `items`, the cursor back to zero: the compaction.
     *
     * The new content is written beside the file, then **the cursor goes to zero, then the file
     * is replaced** (a rename, which is atomic). Stopped after the cursor, the old file is read
     * from its start: windows already sent go again. The other order — new file, then cursor —
     * would read the new file from the old cursor, and skip as many windows as had left.
     */
    async rewrite(items) {
        await this.ensureFolder();
        if (items.length > 0) {
            const content = items.map(lineOf).join('');
            const next = this.file + '.tmp';
            await this.fs.writeFile(next, content);
            if (this.cursor !== 0) await this.fs.writeFile(this.cursorFile, '0');
            this.cursor = 0;
            await this.fs.rename(next, this.file);
            this.lines = items.length;
            this.size = Buffer.byteLength(content);
            return;
        }
        // Emptied: same order, and no file beside it to write — a truncation is one step, and
        // none at all when the file is known to be empty already.
        const known = this.cursor !== null;
        if (this.cursor !== 0) await this.fs.writeFile(this.cursorFile, '0');
        this.cursor = 0;
        if (!known || this.size > 0) await this.fs.writeFile(this.file, '');
        this.lines = 0;
        this.size = 0;
    }

    /** Nothing waits any more, whoever it was waiting for: a sign-out. */
    clear() {
        return this.rewrite([]);
    }
}

module.exports = { FileQueue, QUEUE_FILE, CURSOR_FILE };
