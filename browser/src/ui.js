// The window shared by the popup, the options page and the Word task pane: the same markup
// (ui.css), the same helpers, the same wording. Loaded after i18n.js, before the page's own
// script — and, in the add-in, by a symbolic link into this very file.
//
// **Nothing here may touch `chrome.*` or `Office.*`**: whatever one of the two hosts alone
// provides belongs to that host — pages.js for the extension, agent.js / taskpane.js for the
// pane. `DEFAULT_ENGINE_URL` comes from the host for the same reason (constants.js there,
// agent.js here) and is only ever read while a function below runs, never as this file loads.

// An element by its id. The return type is deliberately `any`: each page knows which element it
// asks for — an input, a link, a <details> — and getElementById cannot. Typing it HTMLElement
// would mean a cast at every call site, which would document nothing and hide the ones that
// matter.
/** @returns {any} */
const $ = (id) => document.getElementById(id);

// An SVG element does not implement the `hidden` property — it lives on HTMLElement — so setting
// it in JavaScript only creates a dead expando and the icon never swaps. The attribute has to be
// written by hand; the stylesheet acts on it.
function showIcon(svg, visible) {
    if (visible) svg.removeAttribute('hidden');
    else svg.setAttribute('hidden', '');
}

// The header's icon actions, shared by the popup and the Word task pane.
//
// An icon names nothing on its own: each button carries its action as an accessible name, and the
// sentence that says what pressing it does as a tooltip. The pause is a toggle, so it also
// carries aria-pressed — and its colour only ever seconds the banner, which keeps saying in plain
// words that the measurement is suspended.
//
// canPause is false when a session is held here but refused by the engine: the account block is
// not drawn then, so the banner the pause colour seconds is not on screen either, and the colour
// would be left alone to carry the state. The log out stays — it is the whole point of showing
// anything at all in that state.
function renderIconActions(paused, canPause = true) {
    $('actions').hidden = false;
    const pause = $('pause');
    pause.hidden = !canPause;
    pause.setAttribute('aria-pressed', String(!!paused));
    pause.setAttribute('aria-label', t(paused ? 'pause.resume' : 'pause.suspend'));
    pause.title = t(paused ? 'pause.resumeTip' : 'pause.suspendTip');
    showIcon($('iconPause'), !paused);
    showIcon($('iconPlay'), !!paused);
    const logout = $('logout');
    logout.setAttribute('aria-label', t('account.logout'));
    logout.title = t('account.logoutTip');
}

// Displays a message in the #message element (its other classes are kept).
// Who is logged in. The engine always computes a display name and falls back to the e-mail
// itself when the account carries neither first nor last name, so the second line only shows
// when it adds something. An engine too old to send a name leaves it empty: the first line
// falls back to the e-mail on its own, and the second disappears.
function showAccount(displayName, email) {
    const name = displayName || email || '';
    $('who').textContent = name;
    const second = $('whoEmail');
    if (!second) return;
    second.textContent = email || '';
    second.hidden = !email || email === name;
}

// "Certimens has been updated", and what changed one click away.
//
// Three of the four agents are updated by their host — a browser updates its extensions, so
// does the Marketplace, and the task pane is served fresh at every opening — and all three do
// it **without a word**: the student finds a button moved and has nowhere to look. The fourth,
// the LibreOffice extension, is told by LibreOffice itself that a new .oxt exists (its
// description.xml says where to ask), and then says the same sentence once installed.
//
// Whether to call this is the host's business — it holds the version the student last saw, and
// the storage differs everywhere. This only draws the line, and `.alert:empty` makes it
// disappear as long as nothing does.
function showUpdateNotice(version) {
    const box = $('updated');
    if (!box) return;
    box.replaceChildren(
        document.createTextNode(t('update.installed', { version }) + ' '),
        Object.assign(document.createElement('a'), {
            href: RELEASE_NOTES_URL,
            target: '_blank',
            rel: 'noopener',
            textContent: t('update.notes'),
        }),
    );
}

function showMessage(text, ok) {
    const el = $('message');
    el.textContent = text;
    el.classList.toggle('ok', ok);
    el.classList.toggle('error', !ok);
}

function clearMessage() {
    $('message').textContent = '';
}

// Error text for a { ok: false, status, code, message } response from the background.
function errorText(res) {
    // A pairing refused — an expired code, a code somebody said they had not asked for — is
    // already worded for the student, and says what to do next. Read as a 401 it would become
    // "wrong credentials", and send them looking for a password nobody ever asked them for.
    if ((res.code || '').startsWith('device_')) return res.message;
    // An address the agent refuses to call is not an engine that failed to answer: it is
    // already worded, and it says what to do about it.
    if (res.code === 'engine_url_refused') return res.message;
    // 401 otherwise: the token was revoked, from the Certimens space or from another agent.
    if (res.status === 401) return t('error.credentials');
    return t('error.engineUnreachable', { message: res.message || t('error.networkError') });
}

// The engine address lives behind "advanced settings". The field is still filled in, so the
// section only opens by itself when it holds something other than the default engine — an
// institution hosting its own. A disclosure that never has anything to say would be noise.
function fillEngineUrl(engineUrl) {
    const url = engineUrl || DEFAULT_ENGINE_URL;
    $('engineUrl').value = url;
    const box = $('advanced');
    if (box) box.open = url !== DEFAULT_ENGINE_URL;
}

// What the form submits. An emptied field means the default engine, not a failed login: the
// input is no longer `required` precisely because a hidden required field would block the submit
// without the browser being able to show the student which field it is complaining about.
function engineUrlValue() {
    return $('engineUrl').value.trim() || DEFAULT_ENGINE_URL;
}

// --- THE ASSIGNMENT PICKER ---
//
// The same `<select>`, the same sentences and the same rules in the popup and in the task pane.
// Written twice, it drifted twice: both sides subtracted `Date` objects to sort, and both had
// to be fixed separately the day the type checker pointed at it.

function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

// The student's assignments, sorted by deadline. One whose deadline has gone by stays listed
// and says so, but cannot be picked: the engine would refuse the hand-in, and an assignment
// that silently vanished from the list would read as a mistake rather than as a closed window.
//
// `state` is the page's view of the open document — `engineId`, `assignmentId`, `frozen` —
// which both hosts already hold under those names.
function renderAssignments(assignments, state) {
    const select = $('assignment');
    // A copy: the caller's list is the engine's answer, and sorting in place would reorder it
    // under whoever else reads it.
    const sorted = [...assignments].sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
    select.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: t(state.engineId ? 'assignment.choose' : 'assignment.none') }),
        ...sorted.map((a) => Object.assign(document.createElement('option'), {
            value: a.id,
            disabled: deadlinePassed(a.deadline) && a.id !== state.assignmentId,
            textContent: t(deadlinePassed(a.deadline) ? 'assignment.overdue' : 'assignment.due', { title: a.title, date: formatDeadline(a.deadline) }),
        })),
    );
    select.value = state.assignmentId || '';
    $('assignmentBox').hidden = state.frozen || sorted.length === 0;
}

// Hand in, or change the assignment already answered — offered only when it would be accepted:
// a copy, a picker on screen, a choice, and a choice that is not the one already recorded.
function updateSubmitButton(state) {
    const chosen = $('assignment').value;
    $('submit').hidden = state.frozen || !state.engineId || $('assignmentBox').hidden || !chosen || chosen === state.assignmentId;
    $('submit').textContent = t(state.assignmentId ? 'doc.changeAssignment' : 'doc.submit');
}

// Whether an assignment's deadline has gone by. The deadline is the door: the engine refuses a
// hand-in past it, and refuses to touch a copy already handed in — until a teacher pushes it,
// which reopens everything at once. Read locally rather than asked for, since the agents already
// hold the date, and since it can go by while a window is open.
function deadlinePassed(deadline) {
    return !!deadline && new Date(deadline) < new Date();
}
