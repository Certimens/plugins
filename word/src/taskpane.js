// Word add-in task pane: student login, the open document's Certimens document,
// assignment submission and .docx upload (the counterpart of browser/popup.js). The page stays
// loaded when the task pane is closed (shared runtime): it is what keeps the measurement running.

// frozen: the deadline of the assignment this document answers has gone by. The engine then
// refuses the name, the assignment and the content of the copy — so the pane stops offering
// them rather than offering a button whose refusal the student can do nothing about. It is a
// date, not a state: pushing the deadline reopens all three, and the next render says so.
const current = { docId: null, engineId: null, assignmentId: null, frozen: false };

// Error response in the format expected by errorText (ui.js).
function failure(err) {
    // code: the rule the engine named, which errorText reads to tell a refusal it can word
    // from a failure to reach the engine at all.
    return { status: err.status || 0, code: err.code || '', message: err.message };
}

// The picker itself is ui.js's, shared with the extension's popup: here, only where the list
// comes from — the engine, asked directly, the pane having no service worker to ask.
async function loadAssignments() {
    let assignments = [];
    try {
        assignments = await listAssignments();
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    renderAssignments(assignments, current);
}

function showLinked(file) {
    current.engineId = file.id;
    current.assignmentId = file.assignment_id;
    current.frozen = deadlinePassed(file.assignment_deadline);
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.name;
    $('open').href = `${trimUrl(getConfig().engineUrl)}/document/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title
        ? t('doc.submittedTo', { title: file.assignment_title })
        : t('doc.submittedGeneric');
    $('deadlineAlert').hidden = !current.frozen;
    $('uploadDocx').hidden = current.frozen;
    $('uploadHint').textContent = current.frozen || !file.content_type ? '' : t('doc.alreadyUploaded');
    updateSubmitButton(current);
    loadWithDocument();
}

// A linked document reopens the add-in when it opens: measurement resumes without the
// student having to open the task pane (setting saved in the document).
function loadWithDocument() {
    try {
        Office.addin.setStartupBehavior(Office.StartupBehavior.load);
    } catch (_) {
        // Word too old: the student opens the task pane themselves
    }
}

function renderSync() {
    const { queue, status } = getState();
    // The suspension comes first: it changes what every other line means. The pause is shared by
    // every document open in this Word, hence the wording.
    const paused = isPaused();
    $('pausedAlert').hidden = !paused;
    // The header's actions follow the session, not the account block: a session the engine
    // refuses keeps its log out — the only way to end it — and loses its pause, whose colour
    // would be left alone to say what the banner above says in words. renderSync also runs on a
    // status change outside a render, hence reading the block rather than recomputing it.
    if (getConfig().token) renderIconActions(paused, !$('account').hidden);
    else $('actions').hidden = true;
    if (paused) {
        $('sync').textContent = queue.length ? t('pause.queued', { count: queue.length }) : '';
        return;
    }
    const labels = {
        synced: t('sync.synced'),
        offline: t('sync.offline', { count: queue.length }),
        auth_error: t('sync.auth_error'),
        unconfigured: t('sync.unconfigured'),
    };
    $('sync').textContent = labels[status.state] || (queue.length ? t('sync.queued', { count: queue.length }) : '');
}

async function submitTo(engineId, assignmentId) {
    try {
        return await submitDocument(engineId, assignmentId);
    } catch (err) {
        showMessage(err.status === 403 ? t('submit.refused', { message: err.message }) : errorText(failure(err)), false);
        return null;
    }
}

async function render() {
    const config = getConfig();
    // The account's language, as soon as it is known; Word's display language until then.
    document.documentElement.lang = setLanguage(config.language, Office.context.displayLanguage);
    applyTranslations();
    const loggedIn = !!config.token && getState().status.state !== 'auth_error';
    $('login').hidden = loggedIn;
    $('account').hidden = !loggedIn;
    renderSync();

    if (!loggedIn) {
        fillEngineUrl(config.engineUrl);
        if (getState().status.state === 'auth_error') showMessage(t('error.authRefused'), false);
        return;
    }

    showAccount(config.displayName, config.email);
    let info = { engineId: null, file: null };
    try {
        info = await docInfo(current.docId);
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    current.engineId = info.engineId || null;
    current.assignmentId = info.file?.assignment_id || null;
    // Read before the assignments are listed: a frozen copy hides the picker along with the rest.
    current.frozen = deadlinePassed(info.file?.assignment_deadline);
    await loadAssignments();
    if (info.file) {
        showLinked(info.file);
    } else {
        $('linked').hidden = true;
        $('create').hidden = false;
        $('createBtn').hidden = false;
        $('submit').hidden = true;
        $('documentName').value = documentName();
    }
}

// The pairing in flight, and its timer. Unlike a browser popup, a task pane stays open while
// the student confirms the code in their browser — so the polling lives here, and stops with the
// pane rather than outliving it.
let pairing = null;
let pairTimer = null;

function stopPairing() {
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = null;
    pairing = null;
    $('pairing').hidden = true;
    $('pairStart').hidden = false;
    $('advanced').hidden = false;
}

// Asks the engine once, then schedules the next attempt at the interval it asked for. Any
// refusal other than "not yet" ends the pairing and is shown: the code expired, or somebody
// refused it.
async function pollOnce() {
    if (!pairing) return;
    if (Date.now() >= pairing.expiresAt) {
        stopPairing();
        showMessage(t('pair.expired'), false);
        return;
    }
    try {
        const token = await pollPairing(pairing);
        if (!token) {
            pairTimer = setTimeout(() => void pollOnce(), pairing.interval);
            return;
        }
        const me = await adoptToken(pairing.engineUrl, token);
        stopPairing();
        showMessage(t('pair.connectedAs', { email: me.display_name || me.email }), true);
        render();
    } catch (err) {
        stopPairing();
        showMessage(errorText(failure(err)), false);
    }
}

$('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('pair.asking'), true);
    try {
        pairing = await startPairing(engineUrlValue());
        $('userCode').textContent = pairing.userCode;
        $('pairOpen').href = pairing.verificationUriComplete;
        $('pairing').hidden = false;
        $('pairStart').hidden = true;
        $('advanced').hidden = true;
        showMessage(t('pair.showCode'), true);
        pairTimer = setTimeout(() => void pollOnce(), pairing.interval);
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    button.disabled = false;
});

$('pairCancel').addEventListener('click', () => {
    stopPairing();
    showMessage('', true);
});

$('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('documentName').value.trim() || documentName();
    const assignmentId = $('assignment').value;
    const button = $('createBtn');
    button.disabled = true;
    let res;
    try {
        res = await createFileFor(current.docId, name, documentName());
    } catch (err) {
        button.disabled = false;
        showMessage(errorText(failure(err)), false);
        return;
    }
    let file = null;
    if (assignmentId) file = await submitTo(res.engineId, assignmentId);
    button.disabled = false;
    if (assignmentId && !file) {
        render(); // file created but not submitted: the error message stays on screen
        return;
    }
    showMessage(t(res.existed ? 'create.existed' : (file ? 'create.createdAndSubmitted' : 'create.created')), true);
    render();
});

$('assignment').addEventListener('change', () => updateSubmitButton(current));

$('submit').addEventListener('click', async () => {
    const button = $('submit');
    button.disabled = true;
    const file = await submitTo(current.engineId, $('assignment').value);
    button.disabled = false;
    if (!file) return;
    showMessage(t('submit.done'), true);
    render();
});

$('uploadDocx').addEventListener('click', async () => {
    const button = $('uploadDocx');
    button.disabled = true;
    showMessage(t('upload.sending'), true);
    try {
        const file = await uploadDocx(current.docId);
        showMessage(t('upload.done'), true);
        showLinked(file);
    } catch (err) {
        // 403 is the deadline having gone by, worded by the agent: it belongs with the refusals
        // the student reads as a sentence, not with "engine unreachable".
        showMessage(err.status === 0 || err.status === 403 || err.status === 413 || err.status === 404
            ? t('upload.failed', { message: err.message })
            : errorText(failure(err)), false);
    }
    button.disabled = false;
});

$('logout').addEventListener('click', async () => {
    await logout();
    clearMessage();
    render();
});

$('pause').addEventListener('click', () => {
    const paused = !isPaused();
    // The window in progress is closed before the pause: nothing measured is lost, and nothing
    // keeps accumulating behind a suspended sensor.
    if (paused) flush('pause');
    setPaused(paused);
    // The permanent banner already says it is suspended (renderSync): confirming it on top put
    // two messages one under the other. Only resuming deserves one, since it leaves nothing.
    if (paused) clearMessage();
    else showMessage(t('pause.resumed'), true);
});

Office.onReady(async (info) => {
    if (info.host !== Office.HostType.Word) return;
    // Before anything else: the agent starts sending straight away, and the messages it words for
    // a refused send (an unreachable engine, a revoked token) must already be in the right
    // language. render() sets it again once the account's own is known.
    setLanguage(getConfig().language, Office.context.displayLanguage);
    current.docId = documentId();
    // The build the page was served with, templated into <body> by word/build.mjs — the same
    // value the cache recovery compares, read from the document because the build templates
    // this page and not the scripts under it. Said after setLanguage, in the right language.
    const updated = updatedVersion(document.body.dataset.build || '');
    if (updated) showUpdateNotice(updated);
    $('webNote').hidden = !isWordOnline();
    onStatusChange(renderSync);
    startAgent();
    render();
    try {
        await startSensor();
    } catch (err) {
        console.warn('Certimens : mesure indisponible.', err);
        showMessage(t('word.measureUnavailable'), false);
    }
});
