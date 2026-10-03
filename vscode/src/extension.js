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

const { Sensor, chars } = require('./sensor.js');
const { Engine, HttpError, DEFAULT_ENGINE_URL, trimUrl, deadlinePassed, formatDeadline } = require('./engine.js');
const { CertimensPanel } = require('./panel.js');
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

function secretsOf(secrets) {
    return {
        get: (key) => secrets.get(key),
        set: (key, value) => secrets.store(key, value),
        delete: (key) => secrets.delete(key),
    };
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
            secrets: secretsOf(context.secrets),
            userAgent: userAgent(context),
            hostLanguage: vscode.env.language,
            schedule: (fn, ms) => setInterval(fn, ms),
            cancel: (id) => clearInterval(id),
        });
        // One sensor per document being written in, keyed by the document's URI.
        this.sensors = new Map();
        // Listeners on the measurement's own state (the panel, the status bar). The engine has
        // its own for the queue: what is suspended here is the sensor, not the sending.
        this.listeners = [];
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
        if (document.uri.scheme !== 'file' || document.isUntitled) return null;
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) return null;
        const relative = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
        const excluded = vscode.workspace.getConfiguration('certimens').get('exclude', DEFAULT_EXCLUDE);
        if (excluded.some((pattern) => matches(pattern, relative))) return null;
        return {
            documentId: `vscode:${projectId(folder)}:${relative}`,
            documentName: `${folder.name}/${relative}`,
        };
    }

    sensorFor(document) {
        const key = document.uri.toString();
        const existing = this.sensors.get(key);
        if (existing) return existing;
        const identity = this.identify(document);
        if (!identity) return null;

        const sensor = new Sensor({
            ...identity,
            volume: () => chars(document.getText()),
            flushed: (item) => this.engine.enqueue(item).catch(warn),
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (id) => clearTimeout(id),
        });
        this.sensors.set(key, sensor);
        this.engine.noteName(identity.documentId, identity.documentName).catch(warn);
        return sensor;
    }

    // --- 3. EDITOR EVENTS ---
    onChange(event) {
        if (this.paused() || event.contentChanges.length === 0) return;
        const sensor = this.sensorFor(event.document);
        if (!sensor) return;
        const changes = event.contentChanges.map((c) => ({ text: c.text, rangeLength: c.rangeLength }));
        sensor.change(changes, reasonOf(event.reason), Date.now());
        this.refreshStatus();
    }

    onSelection(event) {
        if (this.paused()) return;
        // A move in a file never written in opens no window: reading a project is not writing it.
        const sensor = this.sensors.get(event.textEditor.document.uri.toString());
        if (!sensor) return;
        const selected = event.selections.some((s) => !s.isEmpty);
        sensor.move(kindOf(event.kind), selected, Date.now());
    }

    // Leaving the editor closes the window of the file being written, and only that one: the
    // other sensors hold windows that ended before the student left. Coming back is signalled
    // too — not as an activity, but to date what is injected just after it.
    onWindowState(state) {
        if (this.paused()) return;
        const editor = vscode.window.activeTextEditor;
        const sensor = editor && this.sensors.get(editor.document.uri.toString());
        if (!sensor) return;
        if (state.focused) sensor.focus(Date.now());
        else sensor.blur();
    }

    onSave(document) {
        if (this.paused()) return;
        const sensor = this.sensors.get(document.uri.toString());
        if (sensor) sensor.flush('save');
    }

    onClose(document) {
        const key = document.uri.toString();
        const sensor = this.sensors.get(key);
        if (!sensor) return;
        sensor.flush('close');
        this.sensors.delete(key);
        this.refreshStatus();
    }

    // A file renamed or moved keeps its measurements: the engine document is renamed, not replaced.
    // Its documentId still carries the old path, which is what ties the two together — renaming
    // the id instead would orphan every window already queued under it.
    onRename(event) {
        for (const { oldUri, newUri } of event.files) {
            const sensor = this.sensors.get(oldUri.toString());
            if (sensor) {
                sensor.flush('rename');
                this.sensors.delete(oldUri.toString());
            }
            const from = vscode.workspace.getWorkspaceFolder(oldUri);
            const to = vscode.workspace.getWorkspaceFolder(newUri);
            if (!from || !to) continue;
            const relative = vscode.workspace.asRelativePath(oldUri, false).replace(/\\/g, '/');
            const documentId = `vscode:${projectId(from)}:${relative}`;
            if (!this.engine.state().engineIds[documentId]) continue;
            const documentName = `${to.name}/${vscode.workspace.asRelativePath(newUri, false).replace(/\\/g, '/')}`;
            this.engine.noteName(documentId, documentName).then(() => this.engine.drain()).catch(warn);
        }
        this.refreshStatus();
    }

    // --- 4. STATUS ---
    // The status bar carries a state, not the brand: what it must say is whether the measurement
    // is running, and how much has not reached the engine yet.
    refreshStatus() {
        const { queue, status } = this.engine.state();
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
        } else if (queue.length > 0) {
            this.status.text = t('bar.queued', { count: queue.length });
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
    const version = (context.extension && context.extension.packageJSON.version) || '0.0.0';
    return `Certimens-VSCode/${version} (VS Code ${vscode.version}; Node ${process.versions.node})`;
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

// The exclusion patterns are matched here rather than by a file watcher: the decision is taken
// once per document, on a path VS Code has already made relative.
function matches(pattern, relativePath) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const expression = escaped
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${expression}$`).test(relativePath.replace(/\\/g, '/'));
}

function warn(err) {
    console.warn('Certimens :', (err && err.message) || err);
}

function report(err) {
    // A pairing refused — an expired code, a code somebody said they had not asked for — is
    // already worded for the student, and says what to do next. Read as a 401 it would become
    // "wrong credentials", and send them looking for a password nobody ever asked them for.
    const refusal = err instanceof HttpError && (err.code || '').startsWith('device_');
    const message = err instanceof HttpError && err.status === 401 && !refusal
        ? t('error.credentials')
        : (err && err.message) || String(err);
    vscode.window.showErrorMessage(t('error.prefix', { message }));
}

// --- 4. COMMANDS ---
// Pairing from the palette, for a student who would rather not open the panel. No password is
// asked for: the engine hands out a short code, the student confirms it in their Certimens
// space, and this extension is given an API token.
//
// The notification carries the code **and** the button that opens the page, because a modal
// input box asking the student to copy a code out of a notification would be a worse way to
// read eight characters than a notification that holds them.
async function login(engine) {
    // The engine address is not asked here: it is the panel's advanced setting, and every
    // student but those whose institution hosts its own engine uses the default one.
    const engineUrl = engine.config().engineUrl || DEFAULT_ENGINE_URL;
    const pairing = await engine.startPairing(trimUrl(engineUrl));

    void vscode.window.showInformationMessage(
        t('notify.pairCode', { code: pairing.userCode }),
        t('pair.open'),
    ).then((choice) => {
        if (choice) void vscode.env.openExternal(vscode.Uri.parse(pairing.verificationUriComplete));
    });

    // Polled here rather than handed to the panel: the command may have been run without the
    // panel ever being opened.
    while (Date.now() < pairing.expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, pairing.interval));
        const token = await engine.pollPairing(pairing);
        if (!token) continue;
        const me = await engine.adoptToken(pairing.engineUrl, token);
        vscode.window.showInformationMessage(t('notify.pairConnected', { email: me.display_name || me.email }));
        return;
    }
    vscode.window.showWarningMessage(t('error.prefix', { message: t('pair.expired') }));
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
    const { engineId, file } = await agent.engine.fileInfo(identity.documentId);
    if (file && deadlinePassed(file.assignment_deadline)) throw new HttpError(403, t('error.deadlinePassed'));
    await agent.engine.uploadDocument(identity.documentId, editor.document.getText());

    const assignments = await agent.engine.listAssignments();
    if (assignments.length === 0) {
        vscode.window.showInformationMessage(t('submit.sent', { name: identity.documentName }));
        return;
    }
    // A quick pick has no disabled item, where the three other agents grey the line out. An
    // assignment past its deadline is therefore listed, says so in its label, and is turned down
    // on the way out — rather than hidden, which would read as a missing assignment.
    // Each line carries the assignment's id and deadline alongside what the editor displays,
    // which is what the two checks below read. Named, because a quick pick takes plain strings
    // just as happily and would then answer with one.
    /** @type {(vscode.QuickPickItem & { id: string, deadline: string })[]} */
    const items = assignments.map((a) => ({
        label: t(deadlinePassed(a.deadline) ? 'assignment.overdue' : 'assignment.due',
            { title: a.title, date: formatDeadline(a.deadline) }),
        description: a.class_name || '',
        id: a.id,
        deadline: a.deadline,
    }));
    const picked = await vscode.window.showQuickPick(items,
        { title: t('submit.assignmentTitle'), ignoreFocusOut: true });
    if (picked && deadlinePassed(picked.deadline)) throw new HttpError(403, t('error.deadlinePassed'));
    if (!picked) {
        vscode.window.showInformationMessage(t('submit.sentNoAssignment', { name: identity.documentName }));
        return;
    }
    await agent.engine.submitDocument(engineId, picked.id);
    vscode.window.showInformationMessage(t('notify.submitted', { name: identity.documentName, assignment: picked.label }));
}

function run(fn) {
    return (...args) => Promise.resolve()
        .then(() => fn(...args))
        .catch(report);
}

// The running agent, so deactivate() can close the windows still open.
let current = null;

function activate(context) {
    // The account's language if the student is already logged in, the editor's until then.
    setLanguage(context.globalState.get('config', {}).language, vscode.env.language);
    const agent = new Agent(context);
    const panel = new CertimensPanel(context, agent);
    current = agent;

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => agent.onChange(e)),
        vscode.window.onDidChangeTextEditorSelection((e) => agent.onSelection(e)),
        vscode.window.onDidChangeWindowState((e) => agent.onWindowState(e)),
        vscode.workspace.onDidSaveTextDocument((d) => agent.onSave(d)),
        vscode.workspace.onDidCloseTextDocument((d) => agent.onClose(d)),
        vscode.workspace.onDidRenameFiles((e) => agent.onRename(e)),
        vscode.window.registerWebviewViewProvider(CertimensPanel.viewType, panel),
        vscode.commands.registerCommand('certimens.login', run(() => login(agent.engine))),
        vscode.commands.registerCommand('certimens.logout', run(async () => {
            await agent.engine.logout();
            vscode.window.showInformationMessage(t('logout.done'));
        })),
        vscode.commands.registerCommand('certimens.submit', run(() => submit(agent))),
        vscode.commands.registerCommand('certimens.togglePause', run(async () => {
            const paused = !agent.paused();
            await agent.setPaused(paused);
            vscode.window.showInformationMessage(t(paused ? 'notify.paused' : 'notify.resumed'));
        })),
        vscode.commands.registerCommand('certimens.focusPanel', run(() => vscode.commands.executeCommand(`${CertimensPanel.viewType}.focus`))),
        vscode.commands.registerCommand('certimens.flush', run(async () => {
            agent.flushAll('manual');
            await agent.engine.drain();
        })),
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

module.exports = { activate, deactivate, matches, projectId, Agent };
