// Certimens — VS Code extension, host: turns the editor's events into measurements and hands the
// finished windows to the engine client.
//
// A project is measured file by file. Each file the student writes in gets its own sensor, its
// own measurement windows and its own engine document, so a project of twenty files arrives as
// twenty documents rather than one undifferentiated blob — which is what a teacher grades.
//
// Nothing is created on the engine for a file that is merely opened: a sensor exists locally as
// soon as a document is touched, and it reaches the engine only when a window carries real
// activity (see Engine.ensureDocument).

const crypto = require('node:crypto');
const vscode = require('vscode');

const { Sensor, SESSION_ID_BYTES, INJECTION_MIN_CHARS } = require('./sensor.js');
const { Engine, HttpError, DEFAULT_ENGINE_URL, trimUrl, deadlinePassed, formatDeadline } = require('./engine.js');
const { FileQueue } = require('./queue-file.js');
const { CertimensPanel, notify } = require('./panel.js');
const { t, plural, setLanguage } = require('./i18n.js');

// Files no one writes a submission in: dependencies, build output, and the lock files a package
// manager generates. Overridable through `certimens.exclude`.
const DEFAULT_EXCLUDE = [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**', '**/target/**',
    '**/vendor/**', '**/.venv/**', '**/__pycache__/**', '**/*.min.*', '**/*.lock', '**/*-lock.json',
];

// A Memento is a synchronous read and an asynchronous write; the engine client asks for exactly
// that, so it is handed the editor's storage with no adapter of its own.
function storeOf(memento) {
    return {
        get: (key, fallback) => memento.get(key, fallback),
        set: (key, value) => Promise.resolve(memento.update(key, value)),
    };
}

// The offline queue, in a file of the workspace's own storage folder: appending a window there
// costs a line, where the workspace state rewrites everything it holds (queue-file.js). No
// folder — no workspace open, or a storage that is not a local path — and the engine client keeps
// it in the workspace state, as before; with no workspace, nothing is measured anyway.
function queueOf(context) {
    const uri = context.storageUri;
    return uri && uri.scheme === 'file' ? new FileQueue(uri.fsPath) : undefined;
}

function secretsOf(secrets) {
    return {
        get: (key) => secrets.get(key),
        set: (key, value) => secrets.store(key, value),
        delete: (key) => secrets.delete(key),
    };
}

// Where a measured file may live: on this machine, or on the one a remote window is connected to
// (WSL, a container, SSH). The extension runs beside the interface either way, and the editor
// hands it the documents of both; a file of any other scheme — a diff, an output pane, a
// virtual file system — is not something the student is writing a submission in.
const MEASURED_SCHEMES = new Set(['file', 'vscode-remote']);

const slashed = (path) => path.replace(/\\/g, '/');

// --- WHAT BROUGHT A BLOCK ---
// The change event gives the text a gesture inserted, never the gesture: a paste, an accepted
// completion, an assistant's suggestion, a snippet and a code action all arrive the same way.
// What the editor does give, since VS Code 1.97, is a look at every paste and every drop before
// it is applied: `registerDocumentPasteEditProvider`, final in 1.97, and the metadata of
// `registerDocumentDropEditProvider`, final in the same version. Both are registered here for
// the files this agent may measure, and both return no edit: the editor then applies its own
// paste or drop exactly as it would have — it already runs its built-in providers on every
// paste and every drop — with no widget, and no choice put to the student. They note one thing:
// a paste or a drop is landing in this document now. What is being pasted is never read: the
// sensor sees the text the change event inserted, as it always did, and nothing else.
//
// The next change of that document is then the paste. A block that lands with no note, where
// the editor would have given one, was put there by the editor or an assistant at the writer's
// command, and is a `suggest`. Where the editor cannot give one, nothing is said and a block
// stays a `paste`: not knowing is not a suggestion.

// How long a note waits for the change it announces. The editor applies a paste once every
// provider has answered — one of them may ask a language server — and offers the plain paste
// on a click after half a second. A note is spent by the first change of its document anyway,
// so its age only matters when nothing changed at all; a stale one can then only make a later
// suggestion read as a paste, which is how every block read before.
const PASTE_NOTICE_MS = 10 * 1000;
// "Paste as…" puts a list to the student before anything lands: the note waits for the choice.
const PASTE_AS_NOTICE_MS = 2 * 60 * 1000;

// The documents a paste or a drop is noted for: those this agent may measure, in any language.
const WATCHED = [...MEASURED_SCHEMES].map((scheme) => ({ scheme }));

// What a paste or a drop of text carries, and what the editor's own path and link providers
// answer to: a provider is only asked about the kinds of data it names.
const PASTED_TYPES = ['text/plain', 'text/uri-list'];
const DROPPED_TYPES = ['text/plain', 'text/uri-list', 'files'];

// The first editor in which the paste provider is final API. From 1.90 to 1.96 the function is
// already on `vscode.languages` — as a proposal, which throws for any extension not allowed to
// use one — so its presence alone proves nothing: the version is read as well.
const PASTE_PROVIDERS_SINCE = { major: 1, minor: 97 };

// Whether this editor's version (`vscode.version`, "1.97.2" or "1.98.0-insider") has them.
function pasteProvidersIn(version) {
    const [major, minor] = String(version).split('.').map((part) => parseInt(part, 10));
    return major > PASTE_PROVIDERS_SINCE.major
        || (major === PASTE_PROVIDERS_SINCE.major && minor >= PASTE_PROVIDERS_SINCE.minor);
}

// Extensions that bring the clipboard in by edits of their own, without the editor's paste: a
// Vim or a Neovim mode's `p`. With one of them installed, a paste can land unannounced, so no
// block is called a suggestion.
const PASTES_ON_ITS_OWN = ['vscodevim.vim', 'asvetliakov.vscode-neovim'];

/**
 * What this file uses of the editor's API beyond the 1.90 that `@types/vscode` is pinned to, as
 * `@types/vscode` 1.97.0 declares it — and only after checking, at run time, that it is there.
 * Typed here rather than by raising `engines.vscode`: an editor without it keeps every block a
 * `paste`, which is what it was.
 *
 * @typedef {{ readonly value: string }} EditKind
 * @typedef {{
 *   languages: {
 *     registerDocumentPasteEditProvider?: (
 *       selector: vscode.DocumentSelector,
 *       provider: {
 *         provideDocumentPasteEdits(document: vscode.TextDocument, ranges: readonly vscode.Range[],
 *           dataTransfer: vscode.DataTransfer, context: { readonly triggerKind: number }): undefined,
 *       },
 *       metadata: { providedPasteEditKinds: readonly EditKind[], pasteMimeTypes?: readonly string[] },
 *     ) => vscode.Disposable,
 *     registerDocumentDropEditProvider: (
 *       selector: vscode.DocumentSelector,
 *       provider: { provideDocumentDropEdits(document: vscode.TextDocument): undefined },
 *       metadata?: { providedDropEditKinds?: readonly EditKind[], dropMimeTypes: readonly string[] },
 *     ) => vscode.Disposable,
 *   },
 *   DocumentDropOrPasteEditKind?: { readonly Text: EditKind },
 *   DocumentPasteTriggerKind?: { readonly PasteAs: number },
 * }} PasteApi
 */

/**
 * Registers the two providers that tell a paste or a drop from every other block, where the
 * editor has them; returns what to dispose, and nothing where it does not.
 *
 * @param {Agent} agent
 * @returns {vscode.Disposable[]}
 */
function watchPastes(agent) {
    const api = /** @type {PasteApi} */ (/** @type {unknown} */ (vscode));
    // In a browser tab (a codespace, code-server) the editor's own Paste — from the menu or the
    // palette — reads the clipboard and writes it in without asking any provider: a paste would
    // land unannounced, so none is announced at all, and the round trip is not added.
    if (vscode.env.uiKind === vscode.UIKind.Web) return [];
    if (!pasteProvidersIn(vscode.version) || typeof api.languages.registerDocumentPasteEditProvider !== 'function'
        || !api.DocumentDropOrPasteEditKind || !api.DocumentPasteTriggerKind) return [];
    // A provider declares the kinds of edit it may return; this one returns none. `Text` keeps
    // it asked when the student picks "Paste as…" plain text.
    const kinds = [api.DocumentDropOrPasteEditKind.Text];
    const pasteAs = api.DocumentPasteTriggerKind.PasteAs;
    const registered = [];
    try {
        registered.push(api.languages.registerDocumentPasteEditProvider(WATCHED, {
            // Neither `ranges` nor `dataTransfer` is looked at: what is pasted is not read.
            provideDocumentPasteEdits(document, ranges, dataTransfer, context) {
                agent.notePaste(document, context.triggerKind === pasteAs ? PASTE_AS_NOTICE_MS : PASTE_NOTICE_MS);
                return undefined;
            },
        }, { providedPasteEditKinds: kinds, pasteMimeTypes: PASTED_TYPES }));
        registered.push(api.languages.registerDocumentDropEditProvider(WATCHED, {
            provideDocumentDropEdits(document) {
                agent.notePaste(document, PASTE_NOTICE_MS);
                return undefined;
            },
        }, { providedDropEditKinds: kinds, dropMimeTypes: DROPPED_TYPES }));
    } catch (err) {
        // Half a watch would announce pastes and not drops: a drop would read as a suggestion.
        for (const disposable of registered) disposable.dispose();
        warn(err);
        return [];
    }
    agent.announcing = true;
    return registered;
}

// A project's identity, derived from its folder path but never carrying it: what travels to the
// engine is the path inside the project, never the one above it, which names the student's
// account and the machine's layout.
function projectId(folder) {
    return crypto.createHash('sha1').update(folder.uri.toString()).digest('hex').slice(0, 8);
}

class Agent {
    constructor(context) {
        this.context = context;
        this.engine = new Engine({
            store: storeOf(context.globalState),
            // The queue and the files' engine documents belong to the workspace: the global
            // state is one value shared by every window, where two writers lose each other's
            // windows (see ACCOUNT_KEYS in engine.js).
            local: storeOf(context.workspaceState),
            queue: queueOf(context),
            secrets: secretsOf(context.secrets),
            userAgent: userAgent(context),
            // The same build, as its own field: the User-Agent is a sentence the engine parses
            // loosely for a client family, while `X-Certimens-Agent` is a value it stores and
            // shows. Deriving one from the other would make a change of wording in the first a
            // silent change of data in the second.
            version: extensionVersion(context),
            hostLanguage: vscode.env.language,
            schedule: (fn, ms) => setInterval(fn, ms),
            cancel: (id) => clearInterval(id),
        });
        // One sensor per document being written in, keyed by the document's URI.
        this.sensors = new Map();
        // Exclusion decisions, keyed by project-relative path. An excluded document has no
        // sensor to remember it, so without this the list is re-walked on every event.
        this.exclusions = new Map();
        // Listeners on the measurement's own state (the panel, the status bar). The engine has
        // its own for the queue: what is suspended here is the sensor, not the sending.
        this.listeners = [];
        // Whether the editor announces pastes and drops to this agent (see watchPastes), and
        // the notes it gave, by document: until when each explains the next change.
        this.announcing = false;
        /** @type {Map<string, number>} */
        this.notices = new Map();
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.status.command = 'certimens.focusPanel';
        context.subscriptions.push(this.status);
        context.subscriptions.push({ dispose: this.engine.onChange(() => this.refreshStatus()) });
    }

    // --- 1. SUSPENDING THE MEASUREMENT ---
    // Suspension is explicit and it lasts: it survives a reload of the window, and only an
    // explicit resume lifts it. An agent that quietly resumed would be worse than one that never
    // paused, since the student would believe they are measured when they are not.
    paused() {
        return this.context.globalState.get('paused', false);
    }

    // The one question every event handler asks. Measurement belongs to a session: signing out
    // revokes the token, and what the student writes afterwards is nobody's to send — the queue
    // would hold it for whichever account pairs next. A suspension and a sign-out stop the same
    // thing for different reasons, and a handler that remembers only one of them is how both
    // shipped. Read synchronously, which is why it is a flag in the store and not the secret.
    measuring() {
        return !this.paused() && this.signedIn();
    }

    signedIn() {
        return this.context.globalState.get('signedIn', false);
    }

    async setPaused(paused) {
        if (paused === this.paused()) return;
        // The window in progress is closed before the pause: what was measured is already the
        // engine's, and nothing keeps accumulating behind a suspended sensor.
        if (paused) this.flushAll('pause');
        await this.context.globalState.update('paused', paused);
        this.refreshStatus();
        for (const listener of [...this.listeners]) listener();
    }

    onStateChange(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    // --- 2. WHAT IS MEASURED ---
    // The identity of a document for the engine: a project id and the path inside the project.
    // A file outside any workspace folder, an untitled buffer, a git diff, an output pane or an
    // excluded path is not measured at all — its `null` is what keeps a sensor from ever being
    // created for it.
    identify(document) {
        if (document.isUntitled) return null;
        const identity = this.identifyUri(document.uri);
        return identity && !this.isExcluded(identity.relative) ? identity : null;
    }

    // The same, for a path that may no longer hold a file — the old side of a rename.
    identifyUri(uri) {
        if (!MEASURED_SCHEMES.has(uri.scheme)) return null;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return null;
        const relative = slashed(vscode.workspace.asRelativePath(uri, false));
        return {
            relative,
            documentId: `vscode:${projectId(folder)}:${relative}`,
            documentName: `${folder.name}/${relative}`,
        };
    }

    // An excluded path has no sensor, so nothing caches its decision: without this the whole
    // pattern list was walked again on every keystroke in every excluded file, and again on every
    // panel refresh. The answer only changes when the setting does.
    isExcluded(relative) {
        const known = this.exclusions.get(relative);
        if (known !== undefined) return known;
        const patterns = vscode.workspace.getConfiguration('certimens').get('exclude', DEFAULT_EXCLUDE);
        const excluded = Array.isArray(patterns) && patterns.some((pattern) => matches(pattern, relative));
        this.exclusions.set(relative, excluded);
        return excluded;
    }

    // Called when `certimens.exclude` changes: the cached decisions were taken under the old
    // list, and so were the sensors. A file the student has just excluded stops being measured
    // now, not when it is next closed — the setting is the one lever they have over what is
    // measured, and it has to do what it says.
    resetExclusions() {
        this.exclusions.clear();
        for (const document of vscode.workspace.textDocuments) {
            if (this.sensors.has(document.uri.toString()) && !this.identify(document)) this.onClose(document);
        }
    }

    sensorFor(document) {
        const key = document.uri.toString();
        const existing = this.sensors.get(key);
        if (existing) return existing;
        const identity = this.identify(document);
        if (!identity) return null;

        const sensor = new Sensor({
            documentId: identity.documentId,
            documentName: identity.documentName,
            // Read when a block lands in one shot — it is how the sensor tells a sentence
            // duplicated from the document from one brought into it — and when a window is
            // sealed, for its size: the sensor keeps that
            // one reading in memory until the next, to measure how far the text moved, and
            // sends lengths only.
            text: () => document.getText(),
            // A session is one stretch of measuring one file. Its name is drawn at random and
            // derived from nothing: not the account, not the machine, not the path.
            newSession: () => crypto.randomBytes(SESSION_ID_BYTES).toString('base64url'),
            // Node's monotonic clock, on which the sensor measures every duration. The engine
            // reads it beside the wall clock, which only dates a window: a wall clock that was
            // set back between two windows shows, and moves nothing that was measured.
            monotonic: () => performance.now(),
            // A window sealed after the session ended — the idle timer of a keystroke typed
            // while signing out — is nobody's to send: queued, it would wait for whichever
            // account pairs next.
            flushed: (item) => {
                if (this.signedIn()) this.engine.enqueue(item).catch(warn);
            },
            schedule: (fn, ms) => setTimeout(this.engine.guard(fn), ms),
            cancel: (id) => clearTimeout(id),
        });
        this.sensors.set(key, sensor);
        this.engine.noteName(identity.documentId, identity.documentName).catch(warn);
        return sensor;
    }

    // --- 3. EDITOR EVENTS ---
    onChange(event) {
        if (!this.measuring() || event.contentChanges.length === 0) return;
        // Only the file in front of the student is being written by them. The event fires for
        // every document of the workspace, whoever changed it: a symbol renamed across twenty
        // files, a log reloaded from disk, a formatter run on a file in the background. Counted,
        // each became keystrokes nobody typed and an engine document nobody wrote.
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document) return;
        const known = this.sensors.size;
        const sensor = this.sensorFor(event.document);
        if (!sensor) return;
        const changes = event.contentChanges.map((c) => ({ text: c.text, rangeLength: c.rangeLength }));
        sensor.change(changes, reasonOf(event.reason), Date.now(), { pasted: this.pastedInto(event) });
        // The bar counts the files measured: it has something new to say when one was added,
        // not at every keystroke. The queue redraws it by itself (Engine.onChange).
        if (this.sensors.size !== known) this.refreshStatus();
    }

    // The editor is about to apply a paste or a drop to `document` (see watchPastes). Noted
    // whether or not the file is measured yet: the paste may be what starts measuring it.
    notePaste(document, life) {
        this.notices.set(document.uri.toString(), performance.now() + life);
    }

    // What is known of the gesture behind this change, for the sensor (`Sensor.change`): true
    // for the paste or the drop the editor announced, false for a change it would have announced
    // and did not, undefined where it cannot tell.
    pastedInto(event) {
        const key = event.document.uri.toString();
        const until = this.notices.get(key);
        // A note is spent by the first change of its document, whatever that change carries: it
        // is the paste the editor announced, or a keystroke that cancelled it — the editor drops
        // a paste whose document changed while its providers were answering.
        if (until !== undefined) this.notices.delete(key);
        if (!this.announcing) return undefined;
        if (until !== undefined && performance.now() <= until) return true;
        // Only a change long enough to be a block reads the answer, so an ordinary keystroke
        // asks nothing more of the editor. The length in UTF-16 units bounds the characters.
        if (!event.contentChanges.some((c) => c.text.length > INJECTION_MIN_CHARS)) return false;
        // A paste can still land without a note: with `editor.pasteAs.enabled` off the editor
        // asks no paste provider at all, and an extension that writes the clipboard in by its own
        // edits asks none either.
        if (!vscode.workspace.getConfiguration('editor', event.document).get('pasteAs.enabled', true)) return undefined;
        if (PASTES_ON_ITS_OWN.some((id) => vscode.extensions.getExtension(id))) return undefined;
        return false;
    }

    onSelection(event) {
        if (!this.measuring()) return;
        // A move in a file never written in opens no window: reading a project is not writing it.
        const sensor = this.sensors.get(event.textEditor.document.uri.toString());
        if (!sensor) return;
        const selected = event.selections.some((s) => !s.isEmpty);
        // Where the primary cursor went: the sensor measures a keyboard move by its distance,
        // the editor never saying which key made it.
        const active = event.selections[0].active;
        const { line, character } = active;
        sensor.move(kindOf(event.kind), selected, Date.now(), { line, character },
            atEndOfText(event.textEditor.document, active));
    }

    // Leaving the editor closes the window of the file being written, and only that one: the
    // other sensors hold windows that ended before the student left. Coming back is signalled
    // too — not as an activity, but to date what is injected just after it.
    onWindowState(state) {
        // The state may have changed in another window while this one was behind: a suspension,
        // a sign-out. Coming back to the front is when the bar must say so.
        if (state.focused) this.refreshStatus();
        if (!this.measuring()) return;
        const editor = vscode.window.activeTextEditor;
        const sensor = editor && this.sensors.get(editor.document.uri.toString());
        if (state.focused) {
            // A departure belongs to the file it was counted in: the others were not come back
            // to, and must not date a later return that no exit of theirs precedes.
            for (const other of this.sensors.values()) {
                if (other !== sensor) other.forgetDeparture();
            }
            if (sensor) sensor.focus();
        } else if (sensor) {
            sensor.blur();
        }
    }

    onSave(document) {
        if (!this.measuring()) return;
        const sensor = this.sensors.get(document.uri.toString());
        if (sensor) sensor.flush('save');
    }

    onClose(document) {
        const key = document.uri.toString();
        this.notices.delete(key);
        const sensor = this.sensors.get(key);
        if (!sensor) return;
        sensor.flush('close');
        this.sensors.delete(key);
        this.refreshStatus();
    }

    // A file renamed or moved keeps its measurements: its engine document is renamed, not
    // replaced, and everything known under the old path follows it to the new one — the file
    // reopened there is the same document, and the windows still waiting go with it. A folder
    // arrives as one entry and carries every file below it.
    onRename(event) {
        for (const { oldUri, newUri } of event.files) {
            const prefix = oldUri.toString() + '/';
            for (const [key, sensor] of [...this.sensors]) {
                if (key !== oldUri.toString() && !key.startsWith(prefix)) continue;
                sensor.flush('rename');
                this.sensors.delete(key);
            }
            const from = this.identifyUri(oldUri);
            const to = this.identifyUri(newUri);
            // Moved out of every project: nothing follows it, and it is no longer measured.
            if (!from || !to) continue;
            this.engine.moveFile(from.documentId, to.documentId, to.documentName)
                .then(() => this.engine.drain())
                .catch(warn);
        }
        this.exclusions.clear();
        this.refreshStatus();
    }

    // The end of an account's session in this window: every open window is sealed, and no sensor
    // outlives it. One that did would carry its session, its rank and its reading of the text
    // into the next account's first window.
    endSessions(reason) {
        this.flushAll(reason);
        this.sensors.clear();
        this.refreshStatus();
    }

    // --- 4. STATUS ---
    // The status bar carries a state, not the brand: what it must say is whether the measurement
    // is running, and how much has not reached the engine yet.
    refreshStatus() {
        const status = this.engine.status();
        const queued = this.engine.pending();
        const measured = this.sensors.size;
        if (this.paused()) {
            // Said plainly and permanently: a suspended measurement that looks like a running one
            // is the one state this bar must never produce.
            this.status.text = t('bar.paused');
            this.status.tooltip = t('bar.pausedTip');
            this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (status.state === 'unconfigured' || status.state === 'auth_error') {
            this.status.text = t('bar.offline');
            this.status.tooltip = t('bar.offlineTip');
            this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (queued > 0) {
            this.status.text = t('bar.queued', { count: queued });
            this.status.tooltip = status.message || t('bar.queuedTip');
            this.status.backgroundColor = undefined;
        } else {
            this.status.text = plural('bar.measuring', measured);
            this.status.tooltip = t('bar.measuringTip');
            this.status.backgroundColor = undefined;
        }
        this.status.show();
    }

    // Every open window of every file, so nothing measured is lost when VS Code closes.
    flushAll(reason) {
        for (const sensor of this.sensors.values()) sensor.flush(reason);
    }
}

// The user agent the engine recognizes this agent by (its client family). Node sends none of
// the headers a browser
// adds on its own, so without it every push would be filed as coming from a client the platform
// does not know. It carries the extension's version and the editor's, the way a browser's does —
// what it must not carry is anything naming the student.
function userAgent(context) {
    return `Certimens-VSCode/${extensionVersion(context)} (VS Code ${vscode.version}; Node ${process.versions.node})`;
}

// This extension's own build, as the Marketplace package declares it. A checkout that was never
// packaged has none to claim and says 0.0.0 — the number the three other agents fall back on.
function extensionVersion(context) {
    return (context.extension && context.extension.packageJSON.version) || '0.0.0';
}

// How many lines from the last one a caret may be and still be asked about: a file ends on a
// line break more often than not, and sometimes on two.
const END_LINES = 3;

// Whether nothing but blank space follows the caret — the end of the text, as a writer means
// it: the last line of code of a file that ends on a line break is the end, though the editor
// counts one more line below it. Only asked near the bottom, so what is read is a few
// characters and never the file.
function atEndOfText(document, position) {
    if (document.lineCount - 1 - position.line > END_LINES) return false;
    const last = document.lineAt(document.lineCount - 1);
    return document.getText(new vscode.Range(position, last.range.end)).trim() === '';
}

function reasonOf(reason) {
    if (reason === vscode.TextDocumentChangeReason.Undo) return 'undo';
    if (reason === vscode.TextDocumentChangeReason.Redo) return 'redo';
    return '';
}

function kindOf(kind) {
    if (kind === vscode.TextEditorSelectionChangeKind.Mouse) return 'mouse';
    if (kind === vscode.TextEditorSelectionChangeKind.Keyboard) return 'keyboard';
    return 'command';
}

// Within one segment: '*' matches any run of characters, '?' exactly one, and neither crosses a
// separator. Greedy with a single backtrack point, which is what keeps the cost proportional to
// the pattern and the path rather than to what the pattern contains.
function matchSegment(pattern, text) {
    let p = 0;
    let t = 0;
    let star = -1;
    let resume = 0;
    while (t < text.length) {
        if (pattern[p] === '?' || (pattern[p] !== undefined && pattern[p] !== '*' && pattern[p] === text[t])) {
            p++;
            t++;
        } else if (pattern[p] === '*') {
            star = p++;
            resume = t;
        } else if (star >= 0) {
            p = star + 1;
            t = ++resume;
        } else {
            return false;
        }
    }
    while (pattern[p] === '*') p++;
    return p === pattern.length;
}

// A '**' standing alone as a segment matches any number of segments, including none; every other
// segment matches exactly one. Same single-backtrack shape, one level up.
function matchSegments(patterns, segments) {
    let p = 0;
    let s = 0;
    let star = -1;
    let resume = 0;
    while (s < segments.length) {
        if (patterns[p] === '**') {
            star = p++;
            resume = s;
        } else if (p < patterns.length && matchSegment(patterns[p], segments[s])) {
            p++;
            s++;
        } else if (star >= 0) {
            p = star + 1;
            s = ++resume;
        } else {
            return false;
        }
    }
    while (patterns[p] === '**') p++;
    return p === patterns.length;
}

// The exclusion patterns are matched here rather than by a file watcher: the decision is taken
// once per document, on a path VS Code has already made relative.
//
// Matched segment by segment, never through a regular expression. Compiling one with chained
// String.replace passes let each pass rewrite the metacharacters the previous had emitted —
// '(?:.*/)?' and '.*' both contain a '*' and a '?' — so not one shipped default matched anything
// at all; and the expression it produced backtracked without bound, which let a pattern taken
// from a workspace's own settings file freeze the extension host, shared by every extension in
// it, for minutes on a single keystroke.
function matches(pattern, relativePath) {
    return matchSegments(String(pattern).split('/'), String(relativePath).replace(/\\/g, '/').split('/'));
}

// What an entry point could not do. An exception that is not the engine's refusal is a fault of
// this agent's own code, and is counted as such (see Engine.countRuntime).
function warn(err) {
    if (current) current.engine.countRuntime(err);
    console.warn('Certimens :', (err && err.message) || err);
}

function report(err) {
    void notify.failure(err);
}

// --- « SIGNALER UN PROBLÈME » ---
// What the report block says of the editor (docs/moteur.md, « Le bloc »): the engine client
// knows nothing of VS Code, so the host names it. The application's name is added when it is
// not VS Code — VSCodium, Cursor and the others run this same extension, and do not always
// behave alike. A remote window says its kind (`wsl`, `ssh-remote`, `dev-container`), never the
// machine it is connected to.
function aboutEditor() {
    const appName = String(vscode.env.appName || '');
    const remote = vscode.env.remoteName;
    return {
        host: `VS Code ${vscode.version}${appName && !appName.startsWith('Visual Studio Code') ? ` ${appName}` : ''}`,
        os: `${process.platform} ${process.arch}${remote ? ` remote ${remote}` : ''}`,
    };
}

// Opens the engine's help form, prefilled. The address goes to the editor **as the string it
// is**: a `vscode.Uri` is written back with `?`, `=` and `&` encoded in the fragment, which the
// form would no longer read, while a string is opened as given. The link is returned too, which
// is what the host suite reads.
async function reportProblem(agent) {
    const url = agent.engine.reportUrl({ ...aboutEditor(), paused: agent.paused() });
    await vscode.env.openExternal(/** @type {vscode.Uri} */ (/** @type {unknown} */ (url)));
    return url;
}

// --- 5. COMMANDS ---
// Pairing from the palette, for a student who would rather not open the panel. No password is
// asked for: the engine hands out a short code, the student confirms it in their Certimens
// space, and this extension is given an API token.
//
// The notification carries the code **and** the button that opens the page, because a modal
// input box asking the student to copy a code out of a notification would be a worse way to
// read eight characters than a notification that holds them. The waiting is the panel's, opened
// or not: there is one pairing at a time, and one loop that asks for it (CertimensPanel.pair).
async function login(agent, panel) {
    // The engine address is not asked here: it is the panel's advanced setting, and every
    // student but those whose institution hosts its own engine uses the default one.
    const pairing = await panel.pair(trimUrl(agent.engine.config().engineUrl || DEFAULT_ENGINE_URL));
    if (!pairing) return;
    void notify.info(t('notify.pairCode', { code: pairing.userCode }), t('pair.open')).then((choice) => {
        // As a string, like the report link: written back from a `vscode.Uri`, the `=` of its
        // `?user_code=` would be encoded and the page would not find the code.
        if (choice) void vscode.env.openExternal(/** @type {vscode.Uri} */ (/** @type {unknown} */ (pairing.verificationUriComplete)));
    });
}

// Sends the active file to the engine and attaches it to an assignment. This is the only command
// that sends the student's own text: the measurement never does.
async function submit(agent) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new HttpError(0, t('error.noEditor'));
    const identity = agent.identify(editor.document);
    if (!identity) throw new HttpError(0, t('error.notMeasured'));

    const sensor = agent.sensors.get(editor.document.uri.toString());
    if (sensor) sensor.flush('submit');
    await agent.engine.createFileFor(identity.documentId, identity.documentName);
    await agent.engine.drain();

    // A copy handed in to an assignment whose deadline has gone by is finished work: the engine
    // refuses its content as well as its assignment. Asked before the upload rather than after,
    // so the student reads the refusal instead of waiting for a send that was never going to
    // land — and so the file is not read for nothing.
    let { engineId, file } = await agent.engine.fileInfo(identity.documentId);
    if (!engineId) {
        // Deleted on the engine since: the student asked to hand this file in, so it gets a
        // document again rather than a sentence telling them to create one they cannot.
        ({ engineId } = await agent.engine.createFileFor(identity.documentId, identity.documentName));
        file = null;
    }
    if (file && deadlinePassed(file.assignment_deadline)) throw new HttpError(403, t('error.deadlinePassed'));
    await agent.engine.uploadDocument(identity.documentId, editor.document.getText());

    const assignments = await agent.engine.listAssignments();
    if (assignments.length === 0) {
        notify.info(t('submit.sent', { name: identity.documentName }));
        return;
    }
    // A quick pick has no disabled item, where the three other agents grey the line out. An
    // assignment past its deadline is therefore listed, says so in its label, and is turned down
    // on the way out — rather than hidden, which would read as a missing assignment.
    // Each line carries the assignment's id and deadline alongside what the editor displays,
    // which is what the two checks below read. Named, because a quick pick takes plain strings
    // just as happily and would then answer with one.
    /** @type {(vscode.QuickPickItem & { id: string, title: string, deadline: string })[]} */
    const items = assignments.map((a) => ({
        // An assignment without a deadline has no date to show, and is never overdue.
        label: a.deadline
            ? t(deadlinePassed(a.deadline) ? 'assignment.overdue' : 'assignment.due',
                { title: a.title, date: formatDeadline(a.deadline) })
            : a.title,
        description: a.class_name || '',
        id: a.id,
        title: a.title,
        deadline: a.deadline,
    }));
    const picked = await vscode.window.showQuickPick(items,
        { title: t('submit.assignmentTitle'), ignoreFocusOut: true });
    if (picked && deadlinePassed(picked.deadline)) throw new HttpError(403, t('error.deadlinePassed'));
    if (!picked) {
        notify.info(t('submit.sentNoAssignment', { name: identity.documentName }));
        return;
    }
    await agent.engine.submitDocument(engineId, picked.id);
    notify.info(t('notify.submitted', { name: identity.documentName, assignment: picked.title }));
}

// A command: what it throws is told to the student, and counted when it is a fault of ours
// rather than the engine's answer.
function run(fn) {
    return (...args) => Promise.resolve()
        .then(() => fn(...args))
        .catch((err) => {
            if (current) current.engine.countRuntime(err);
            report(err);
        });
}

// The running agent, so deactivate() can close the windows still open.
let current = null;

function activate(context) {
    // The account's language if the student is already logged in, the editor's until then.
    setLanguage(context.globalState.get('config', {}).language, vscode.env.language);
    const agent = new Agent(context);
    const panel = new CertimensPanel(context, agent);
    current = agent;
    agent.engine.noteStart();

    // Each listener is guarded, so an exception of ours is counted as `error.runtime`. There is
    // deliberately no process-wide `uncaughtException` or `unhandledRejection` handler: the
    // extension host is shared with every other extension installed, and what they throw is not
    // this agent's to count — nor to swallow. Commands go through `run`, timers through
    // `Engine.guard` or `Engine.tick`.
    const guard = (fn) => agent.engine.guard(fn);
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(guard((e) => agent.onChange(e))),
        vscode.window.onDidChangeTextEditorSelection(guard((e) => agent.onSelection(e))),
        vscode.window.onDidChangeWindowState(guard((e) => agent.onWindowState(e))),
        vscode.workspace.onDidSaveTextDocument(guard((d) => agent.onSave(d))),
        vscode.workspace.onDidCloseTextDocument(guard((d) => agent.onClose(d))),
        vscode.workspace.onDidRenameFiles(guard((e) => agent.onRename(e))),
        vscode.workspace.onDidChangeConfiguration(guard((e) => {
            if (e.affectsConfiguration('certimens.exclude')) agent.resetExclusions();
        })),
        ...watchPastes(agent),
        vscode.window.registerWebviewViewProvider(CertimensPanel.viewType, panel),
        vscode.commands.registerCommand('certimens.login', run(() => login(agent, panel))),
        vscode.commands.registerCommand('certimens.logout', run(async () => {
            // The windows still open belong to the session that is ending, so they are sealed
            // and sent while the token that measured them is still valid. What signing out then
            // clears, it clears for good: a window left in the queue would be sent under the
            // next account's bearer, towards this account's documents.
            agent.endSessions('logout');
            await agent.engine.drain().catch(warn);
            const revoked = await agent.engine.logout();
            // Whatever was typed while the engine was answering was measured under a session
            // that no longer exists: its sensors go, and their windows are not queued.
            agent.endSessions('logout');
            notify.info(t(revoked ? 'logout.done' : 'logout.doneLocal'));
        })),
        vscode.commands.registerCommand('certimens.submit', run(() => submit(agent))),
        vscode.commands.registerCommand('certimens.togglePause', run(async () => {
            const paused = !agent.paused();
            await agent.setPaused(paused);
            notify.info(t(paused ? 'notify.paused' : 'notify.resumed'));
        })),
        vscode.commands.registerCommand('certimens.focusPanel', run(() => vscode.commands.executeCommand(`${CertimensPanel.viewType}.focus`))),
        vscode.commands.registerCommand('certimens.flush', run(async () => {
            agent.flushAll('manual');
            await agent.engine.drain();
        })),
        vscode.commands.registerCommand('certimens.reportProblem', run(() => reportProblem(agent))),
    );

    agent.engine.start().catch(warn);
    agent.refreshStatus();
    return { agent }; // what the panel and an integration test talk to
}

// VS Code awaits what deactivate returns, but only briefly: the open windows are closed and
// queued, and whatever the network did not carry away goes out at the next start.
function deactivate() {
    if (!current) return undefined;
    const agent = current;
    current = null;
    agent.flushAll('deactivate');
    agent.engine.stop();
    return agent.engine.drain().catch(warn);
}

module.exports = { activate, deactivate, matches, projectId, watchPastes, pasteProvidersIn, Agent };
