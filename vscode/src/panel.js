// Certimens — VS Code extension, side panel (the counterpart of browser/popup.html and
// word/taskpane.js).
//
// A webview rather than a tree view: it is the same screen as the browser popup and the Word
// task pane — log in, see what the file being written is tied to, send it — and it reuses the
// product's stylesheet, so a student who has seen one of the agents has seen them all.
//
// The webview holds no state and decides nothing: it renders what the extension sends it and
// posts back what the student clicked. Everything else stays on this side, where the API token
// is and where the webview cannot reach it.

const crypto = require('node:crypto');
const vscode = require('vscode');

const { t, plural, currentLanguage } = require('./i18n.js');

// The webview may load only what the extension ships, from the extension's own folder: no CDN,
// no remote font, no inline script but the one this nonce allows.
function contentSecurityPolicy(webview, nonce) {
    return [
        "default-src 'none'",
        `img-src ${webview.cspSource}`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
}

// The dictionary's strings go into the page as HTML: they are ours, but a template that only
// works as long as no translation holds a quote is a trap for whoever writes the next one.
function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A CSP nonce is only worth anything if it cannot be guessed: Math.random is a sequence, not a
// secret.
function nonce() {
    return crypto.randomBytes(24).toString('base64url');
}

// What a status reads as for a student. The engine's own vocabulary ('synced', 'offline') says
// nothing to them, and the queue length is what they actually want to know.
function statusText(status, queued, paused) {
    // The suspension comes first: it is the one state that changes what the other lines mean.
    // The queue keeps draining while paused — what was measured before belongs to the engine
    // already, and holding it back would only turn a pause into a late, suspicious batch.
    if (paused) {
        // The panel's banner already says it is suspended: this line only adds something when
        // measurements from before the pause are still waiting. Otherwise it keeps quiet rather
        // than repeating the banner right above it.
        return queued > 0
            ? { text: plural('panel.pausedQueued', queued), kind: 'error' }
            : { text: '', kind: '' };
    }
    if (status.state === 'unconfigured') return { text: t('panel.notConnected'), kind: 'info' };
    if (status.state === 'auth_error') return { text: t('panel.authRefused'), kind: 'error' };
    if (queued > 0) return { text: plural('panel.queued', queued), kind: 'info' };
    if (status.state === 'offline') {
        return { text: t('error.engineUnreachable', { message: status.message || t('error.networkError') }), kind: 'error' };
    }
    return { text: t('panel.synced'), kind: 'ok' };
}

class CertimensPanel {
    constructor(context, agent) {
        this.context = context;
        this.agent = agent;
        this.view = null;
        context.subscriptions.push({ dispose: agent.engine.onChange(() => this.refresh()) });
        context.subscriptions.push({ dispose: agent.onStateChange(() => this.refresh()) });
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.refresh()));
    }

    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'src', 'media')],
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((message) => this.handle(message));
        view.onDidDispose(() => { this.view = null; });
        this.refresh();
    }

    media(name) {
        return this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src', 'media', name));
    }

    html(webview) {
        const n = nonce();
        return `<!DOCTYPE html>
<html lang="${currentLanguage()}">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview, n)}">
    <link rel="stylesheet" href="${this.media('ui.css')}">
    <style>
        body { padding: 16px; }
        h1 { font-size: 1.35rem; }
        h2 { font-size: 1rem; font-weight: 700; letter-spacing: 0; word-break: break-all; }
        .card { padding: 16px; }
        .measured { max-height: 180px; overflow-y: auto; }
        .measured div { padding: 2px 0; word-break: break-all; }
    </style>
</head>
<body class="stack" style="gap: 12px">
    <div class="brand">
        <img class="mark" src="${this.media('icon128.png')}" alt="">
        <h1>Certi<span class="mens">mens</span></h1>
        <div id="actions" class="icon-actions" hidden>
            <button type="button" id="pause" class="icon-btn" aria-pressed="false">
                <svg id="iconPause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9.5 5v14M14.5 5v14"/></svg>
                <svg id="iconPlay" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true" hidden><path d="M8 5.5l11 6.5-11 6.5z"/></svg>
            </button>
            <button type="button" id="logout" class="icon-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9"/><path d="M17.5 8.5 21 12l-3.5 3.5"/><path d="M21 12H10"/></svg>
            </button>
        </div>
    </div>

    <form id="login" class="card stack" hidden>
        <p class="muted small">${esc(t('login.intro'))}</p>
        <div class="field">
            <label for="email">${esc(t('login.email'))}</label>
            <input id="email" type="email" required autocomplete="username">
        </div>
        <div class="field">
            <label for="password">${esc(t('login.password'))}</label>
            <input id="password" type="password" required autocomplete="current-password">
        </div>
        <div class="field">
            <label for="engineUrl">${esc(t('login.engineUrl'))}</label>
            <input id="engineUrl" type="url" required placeholder="https://monespace.certimens.fr">
        </div>
        <button type="submit" class="btn block">${esc(t('login.submit'))}</button>
    </form>

    <div id="account" class="stack" style="gap: 12px" hidden>
        <div class="small">
            <span class="muted">${esc(t('account.connected'))} <strong id="who" style="color: var(--text)"></strong></span>
            <div id="whoEmail" class="muted" hidden></div>
        </div>
        <div id="pausedAlert" class="alert error small" hidden>${esc(t('panel.pausedAlert'))}</div>

        <div id="doc" class="card stack" hidden>
            <div class="muted small">${esc(t('panel.openFile'))}</div>
            <h2 id="docName"></h2>
            <div id="linked" class="alert ok small" hidden>${esc(t('panel.linked'))}</div>
            <div id="unlinked" class="muted small" hidden>${esc(t('panel.unlinked'))}</div>
            <button type="button" id="submit" class="btn block">${esc(t('panel.submit'))}</button>
        </div>
        <div id="noDoc" class="card muted small" hidden>${esc(t('panel.noFile'))}</div>

        <div class="card stack" style="gap: 8px">
            <div id="measuring" class="muted small">${esc(t('panel.measured'))}</div>
            <div id="measured" class="measured small"></div>
        </div>
    </div>

    <div id="message" class="alert small"></div>

    <script nonce="${n}">
        // Le panneau suit le thème de **l'éditeur**, pas celui du système : VS Code pose
        // vscode-light, vscode-dark ou vscode-high-contrast sur <body>, et les échange à chaud
        // quand l'étudiant change de thème. ui.css lit data-theme ; on ne fait que recopier.
        const theme = () => {
            const dark = document.body.classList.contains('vscode-dark')
                || document.body.classList.contains('vscode-high-contrast');
            document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        };
        theme();
        new MutationObserver(theme).observe(document.body, { attributeFilter: ['class'] });

        const vscode = acquireVsCodeApi();
        const $ = (id) => document.getElementById(id);
        const show = (id, on) => { $(id).hidden = !on; };
        const showIcon = (svg, on) => (on ? svg.removeAttribute('hidden') : svg.setAttribute('hidden', ''));

        $('login').addEventListener('submit', (e) => {
            e.preventDefault();
            vscode.postMessage({
                type: 'login',
                engineUrl: $('engineUrl').value,
                email: $('email').value,
                password: $('password').value,
            });
            $('password').value = '';
        });
        $('logout').addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
        $('submit').addEventListener('click', () => vscode.postMessage({ type: 'submit' }));
        $('pause').addEventListener('click', () => vscode.postMessage({ type: 'togglePause' }));

        window.addEventListener('message', (event) => {
            const state = event.data;
            show('login', !state.connected);
            show('account', state.connected);
            // The name the engine computes, with the e-mail underneath when it adds something.
            const name = state.displayName || state.email || '';
            $('who').textContent = name;
            $('whoEmail').textContent = state.email || '';
            $('whoEmail').hidden = !state.email || state.email === name;
            $('engineUrl').value = state.engineUrl;
            $('email').value = state.email;

            show('doc', !!state.document);
            show('noDoc', state.connected && !state.document);
            if (state.document) {
                $('docName').textContent = state.document.name;
                show('linked', state.document.linked);
                show('unlinked', !state.document.linked);
            }

            show('pausedAlert', state.paused);
            show('measuring', !state.paused);
            show('actions', state.connected);

            // An icon names nothing on its own: each button carries its action as an accessible
            // name, and the sentence that says what pressing it does as a tooltip.
            const pause = $('pause');
            pause.setAttribute('aria-pressed', String(!!state.paused));
            pause.setAttribute('aria-label', state.paused ? state.labels.resume : state.labels.suspend);
            pause.title = state.paused ? state.labels.resumeTip : state.labels.suspendTip;
            // An SVG element does not implement the hidden property (it lives on HTMLElement):
            // the attribute has to be written by hand, or the icon never swaps. No backtick in
            // this block — all of it lives inside the template that builds the page.
            showIcon($('iconPause'), !state.paused);
            showIcon($('iconPlay'), !!state.paused);
            $('logout').setAttribute('aria-label', state.labels.logout);
            $('logout').title = state.labels.logoutTip;

            $('measured').textContent = '';
            for (const name of state.measured) {
                const row = document.createElement('div');
                row.textContent = name;
                $('measured').appendChild(row);
            }
            if (state.measured.length === 0) $('measured').textContent = state.labels.noneMeasured;
            show('measured', !state.paused);

            const message = $('message');
            message.textContent = state.status.text;
            message.className = 'alert small ' + state.status.kind;
        });
    </script>
</body>
</html>`;
    }

    // --- STATE ---
    refresh() {
        if (!this.view) return;
        const engine = this.agent.engine;
        const { queue, status, engineIds } = engine.state();
        const config = engine.config();
        const editor = vscode.window.activeTextEditor;
        const identity = editor ? this.agent.identify(editor.document) : null;

        engine.configured().then((connected) => {
            if (!this.view) return;
            this.view.webview.postMessage({
                connected,
                engineUrl: config.engineUrl,
                email: config.email,
                displayName: config.displayName,
                paused: this.agent.paused(),
                labels: {
                    suspend: t('pause.suspend'),
                    resume: t('pause.resume'),
                    suspendTip: t('pause.suspendTip'),
                    resumeTip: t('pause.resumeTip'),
                    logout: t('account.logout'),
                    logoutTip: t('account.logoutTip'),
                    noneMeasured: t('panel.measuredNone'),
                },
                status: statusText(status, queue.length, this.agent.paused()),
                document: identity && { name: identity.documentName, linked: !!engineIds[identity.documentId] },
                // The files measured since this window opened, which is what the student can
                // check against what the engine shows.
                measured: [...this.agent.sensors.values()].map((sensor) => sensor.documentName).sort(),
            });
        }, () => {});
    }

    handle(message) {
        const commands = {
            login: () => this.agent.engine
                .login({ engineUrl: message.engineUrl, email: message.email, password: message.password })
                .then((me) => vscode.window.showInformationMessage(t('login.done', { email: me.email }))),
            logout: () => this.agent.engine.logout(),
            submit: () => vscode.commands.executeCommand('certimens.submit'),
            togglePause: () => vscode.commands.executeCommand('certimens.togglePause'),
        };
        const command = commands[message.type];
        if (!command) return;
        Promise.resolve()
            .then(command)
            .then(() => this.refresh())
            .catch((err) => vscode.window.showErrorMessage(t('error.prefix', { message: err.message || err })));
    }
}

// The id the view is declared under in package.json; the status bar focuses it by this name.
CertimensPanel.viewType = 'certimens.panel';

module.exports = { CertimensPanel, statusText, contentSecurityPolicy };
