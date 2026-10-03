// Word add-in task pane: student login, the open document's Certimens document,
// assignment submission and .docx upload (the counterpart of browser/popup.js). The page stays
// loaded when the task pane is closed (shared runtime): it is what keeps the measurement running.

const current = { docId: null, engineId: null, assignmentId: null };

function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

// Error response in the format expected by errorText (ui.js).
function failure(err) {
    return { status: err.status || 0, message: err.message };
}

// The student's assignments, sorted by deadline; overdue ones stay listed but are flagged.
async function loadAssignments() {
    const select = $('assignment');
    let assignments = [];
    try {
        assignments = await listAssignments();
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    assignments.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    select.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: t(current.engineId ? 'assignment.choose' : 'assignment.none') }),
        ...assignments.map((a) => Object.assign(document.createElement('option'), {
            value: a.id,
            textContent: t(new Date(a.deadline) < new Date() ? 'assignment.overdue' : 'assignment.due', { title: a.title, date: formatDeadline(a.deadline) }),
        })),
    );
    select.value = current.assignmentId || '';
    $('assignmentBox').hidden = assignments.length === 0;
}

function showLinked(file) {
    current.engineId = file.id;
    current.assignmentId = file.assignment_id;
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.name;
    $('open').href = `${trimUrl(getConfig().engineUrl)}/document/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title
        ? t('doc.submittedTo', { title: file.assignment_title })
        : t('doc.submittedGeneric');
    $('uploadHint').textContent = file.content_type ? t('doc.alreadyUploaded') : '';
    updateSubmitButton();
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

function updateSubmitButton() {
    const chosen = $('assignment').value;
    $('submit').hidden = !current.engineId || $('assignmentBox').hidden || !chosen || chosen === current.assignmentId;
    $('submit').textContent = t(current.assignmentId ? 'doc.changeAssignment' : 'doc.submit');
}

function renderSync() {
    const { queue, status } = getState();
    // The suspension comes first: it changes what every other line means. The pause is shared by
    // every document open in this Word, hence the wording.
    const paused = isPaused();
    $('pausedAlert').hidden = !paused;
    // renderSync also runs on a status change while logged out (a send that failed before the
    // session ended): the header's actions must not reappear then.
    if (!$('account').hidden) renderIconActions(paused);
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
        // Nothing to suspend and nothing to log out of before the student is connected.
        $('actions').hidden = true;
        fillEngineUrl(config.engineUrl);
        $('email').value = config.email || '';
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

$('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('login.connecting'), true);
    try {
        const me = await login({
            engineUrl: engineUrlValue(),
            email: $('email').value.trim(),
            password: $('password').value,
        });
        $('password').value = '';
        showMessage(t('login.loggedInAs', { email: me.email }), true);
        render();
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    button.disabled = false;
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

$('assignment').addEventListener('change', updateSubmitButton);

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
        showMessage(err.status === 0 || err.status === 413 || err.status === 404
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
