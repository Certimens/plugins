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
    // The address comes out of a localStorage this origin shares with every other page GitHub
    // Pages serves from the same account (SECURITY.md says so, and says it is known). Checked
    // before it becomes an `href`, so a `javascript:` written there by one of them is not one
    // click away in the page that holds the token.
    const config = getConfig();
    const allowed = engineUrlAllowed(config.engineUrl);
    $('open').hidden = !allowed;
    if (allowed) $('open').href = `${trimUrl(config.engineUrl)}/document/${file.id}`;
    else $('open').removeAttribute('href');
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
    // While the student has not said whether this file was moved or copied, it has no record
    // to show and none to create: creating one here would answer "a copy" in their place.
    const asking = movedDocumentPending();
    // Shown once worded: the record's name is being asked of the engine meanwhile.
    $('moved').hidden = !asking || !$('movedQuestion').textContent;
    if (asking) {
        for (const id of ['linked', 'create', 'createBtn', 'submit', 'assignmentBox']) $(id).hidden = true;
        return;
    }
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
//
// Each `await` may come back to a pairing that was cancelled or replaced meanwhile: what it
// then holds is nobody's, and it stops there. Without that check a pairing cancelled while a
// poll was in flight failed on a null, and one restarted at once was polled on two timers.
async function pollOnce() {
    const mine = pairing;
    if (!mine) return;
    if (Date.now() >= mine.expiresAt) {
        stopPairing();
        showMessage(t('pair.expired'), false);
        return;
    }
    const again = () => { pairTimer = setTimeout(() => void pollOnce(), mine.interval); };
    try {
        const token = mine.token || await pollPairing(mine);
        if (pairing !== mine) return;
        if (!token) {
            again();
            return;
        }
        // Kept on the pairing: the engine hands a token out once, and the two calls that adopt
        // it can fail for a reason that has nothing to do with it. Dropped here, it stayed
        // alive at the engine with nobody left to revoke it.
        mine.token = token;
        let me;
        try {
            me = await adoptToken(mine.engineUrl, token);
        } catch (err) {
            if (pairing !== mine || err.status) throw err;
            again(); // no answer: asked again at the next turn, until the pairing expires
            return;
        }
        if (pairing === mine) stopPairing();
        showMessage(t('pair.connectedAs', { email: me.display_name || me.email }), true);
        // The file may name a document of the account that has just arrived: asked now, before
        // the first window creates another in its place.
        startResume(current.docId).catch(() => null).then(render);
    } catch (err) {
        if (pairing !== mine) return;
        stopPairing();
        showMessage(errorText(failure(err)), false);
    }
}

$('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('pair.asking'), true);
    stopPairing();
    try {
        const opened = await startPairing(engineUrlValue());
        pairing = opened;
        $('userCode').textContent = opened.userCode;
        $('pairOpen').href = opened.verificationUriComplete;
        $('pairing').hidden = false;
        $('pairStart').hidden = true;
        $('advanced').hidden = true;
        showMessage(t('pair.showCode'), true);
        pairTimer = setTimeout(() => void pollOnce(), opened.interval);
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

// The file carries an identity bound to another location (agent.js, MOVED OR COPIED). Asked
// once, when the pane opens; the question names the record the file would rejoin, as the engine
// names it, so the student sees what they are attaching it to.
async function askIfMoved() {
    const question = await movedDocumentQuestion();
    if (!question) {
        if (!$('moved').hidden) render();
        return;
    }
    $('movedQuestion').textContent = question.name
        ? t('word.movedQuestion', { name: question.name, previous: question.previous })
        : t('word.movedQuestionUnnamed', { previous: question.previous });
    render();
    // A linked document opens the add-in without its pane (loadWithDocument): the question is
    // the one thing that needs the student, so the pane is brought up for it.
    try {
        Office.addin.showAsTaskpane().catch(() => {});
    } catch (_) {
        // Word too old: the question waits for the student to open the pane
    }
}

async function answerMoved(same) {
    const buttons = [$('movedSame'), $('movedCopy')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
        const settled = await settleRelocation(same);
        if (settled?.file) showMessage(t('word.movedRejoined', { name: settled.file.name }), true);
        else if (settled?.refused) showMessage(t('word.movedRefused'), false);
        else clearMessage();
        render();
    } catch (err) {
        // The engine could not be asked whose record it is: nothing is decided, and the
        // question stays for another try.
        showMessage(errorText(failure(err)), false);
    }
    buttons.forEach((button) => { button.disabled = false; });
}

$('movedSame').addEventListener('click', () => void answerMoved(true));
$('movedCopy').addEventListener('click', () => void answerMoved(false));

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
    // The window still open belongs to the session that is ending: sealed now, it leaves with
    // the queue while the token that measured it is still valid.
    if (measuring()) flush('logout');
    const revoked = await logout();
    render();
    // Said only when it is not what the student expects: a revocation that did not reach the
    // engine leaves a token that never expires alive, and only they can go and kill it.
    if (revoked) clearMessage();
    else showMessage(t('account.loggedOutLocal'), false);
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
    // The reference is retaken now, before anything is typed against the one from before the
    // suspension (see `stale` in sensor.js).
    if (!paused) scheduleRead();
});

// "Signaler un problème": the help form of the Certimens space, prefilled (agent.js builds the
// link). It goes to the **student's browser**, not the pane: on Word for Windows and Mac a
// `window.open` stays inside Office's webview, a window with no address bar, no password manager
// and no session of their Certimens space. `openBrowserWindow` (OpenBrowserWindowApi 1.1) is what
// hands the address to the system browser — on Windows, Mac and iPad; Word on the web does not
// have it, and there `window.open` is already a tab of the browser the student is in.
function openReport() {
    const url = reportLink();
    try {
        if (Office.context.requirements.isSetSupported('OpenBrowserWindowApi', '1.1')) {
            Office.context.ui.openBrowserWindow(url);
            return;
        }
    } catch (_) {
        // Office refused or does not know the set: the plain window below still opens the form.
    }
    window.open(url, '_blank', 'noopener');
}

$('report').addEventListener('click', openReport);

// Before anything else of ours runs, so an exception in the code below is counted too.
watchErrors();

Office.onReady(async (info) => {
    if (info.host !== Office.HostType.Word) return;
    // Before `updatedVersion`, which records the build this pane was served with: the launch is
    // told apart from an install by what was recorded before this opening.
    noteLaunch();
    // Before anything else: the agent starts sending straight away, and the messages it words for
    // a refused send (an unreachable engine, a revoked token) must already be in the right
    // language. render() sets it again once the account's own is known.
    setLanguage(getConfig().language, Office.context.displayLanguage);
    current.docId = await documentId();
    // A move confirmed by the student hands this pane, and its sensor, the original identity.
    onDocumentIdChange((id) => {
        current.docId = id;
        followDocument(id);
    });
    // A file that already names an engine document rejoins it rather than opening a second
    // one. Not awaited: it is a network call, and the pane must not wait on the engine to
    // appear — the measurement starts straight away either way, and the pane redraws itself
    // when the answer lands.
    startResume(current.docId).then((file) => {
        if (file) render();
    }).catch((err) => {
        // Nobody signed in yet is the ordinary case of a first opening: asked again after
        // pairing, and before any document is created (pendingResume).
        if (err.status !== 401) console.warn('Certimens : reprise du document impossible.', err);
    });
    // The build the page was served with, templated into <body> by word/build.mjs — the same
    // value the cache recovery compares, read from the document because the build templates
    // this page and not the scripts under it. Said after setLanguage, in the right language.
    const updated = updatedVersion(document.body.dataset.build || '');
    if (updated) showUpdateNotice(updated);
    $('webNote').hidden = !isWordOnline();
    onStatusChange(renderSync);
    // Every open document has its own pane over one storage, and learns nothing of the others
    // unless it listens: a suspension or a sign-out made in another pane left this one showing
    // the opposite, and its suspend button then *resumed*. The event only fires in the panes
    // that did not write.
    watchOtherPanes(render, renderSync);
    startAgent();
    render();
    void askIfMoved();
    try {
        await startSensor();
    } catch (err) {
        console.warn('Certimens : mesure indisponible.', err);
        showMessage(t('word.measureUnavailable'), false);
    }
});
