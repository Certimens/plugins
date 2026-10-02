// Popup: student login and creation of the Certimens document for the open document
// (Google Docs or Word Online).

// Google Docs export hosts: docs.google.com redirects to googleusercontent.com.
const GOOGLE_EXPORT_ORIGINS = ['https://docs.google.com/document/*', 'https://*.googleusercontent.com/*'];

// The open document is requested from the tab's content script: for Word Online, it runs
// in the editing iframe, the only one that knows the document (the tab URL doesn't say).
async function activeDocument() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    try {
        const doc = await chrome.tabs.sendMessage(tab.id, { type: 'CERTIMENS_ACTIVE_DOC' });
        return doc ? { ...doc, tabId: tab.id } : null;
    } catch (_) {
        return null; // no supported editor in this tab
    }
}

const current = { engineUrl: DEFAULT_ENGINE_URL, doc: null, engineId: null, assignmentId: null, paused: false };

function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

// The student's assignments, sorted by deadline; overdue assignments stay listed but flagged.
async function loadAssignments() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_ASSIGNMENTS' });
    const select = $('assignment');
    const assignments = res.ok ? res.assignments : [];
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
    return assignments;
}

function showLinked(file) {
    current.engineId = file.id;
    current.assignmentId = file.assignment_id;
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.name;
    $('open').href = `${current.engineUrl}/document/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title
        ? t('doc.submittedTo', { title: file.assignment_title })
        : t('doc.submittedGeneric');
    showUpload(file);
    updateSubmitButton();
}

function showUpload(file) {
    const canExport = !!current.doc?.canExport;
    $('exportDocx').hidden = !canExport;
    $('pickDocx').hidden = canExport;
    $('uploadHint').textContent = [
        file.content_type ? t('doc.alreadyUploaded') : null,
        canExport ? null : t('doc.wordSaveHint'),
    ].filter(Boolean).join(' ');
}

function updateSubmitButton() {
    const chosen = $('assignment').value;
    $('submit').hidden = !current.engineId || $('assignmentBox').hidden || !chosen || chosen === current.assignmentId;
    $('submit').textContent = t(current.assignmentId ? 'doc.changeAssignment' : 'doc.submit');
}

async function submitTo(engineId, assignmentId) {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_SUBMIT_FILE', engineId, assignmentId });
    if (!res.ok) {
        showMessage(res.status === 403 ? t('submit.refused', { message: res.message }) : errorText(res), false);
        return null;
    }
    return res.file;
}

async function render() {
    const s = await chrome.runtime.sendMessage({ type: 'CERTIMENS_STATUS' });
    // The account's language, as soon as it is known; the browser's until then.
    startLanguage(s);
    current.engineUrl = s.engineUrl || DEFAULT_ENGINE_URL;
    const loggedIn = s.configured && s.status.state !== 'auth_error';
    $('login').hidden = loggedIn;
    $('account').hidden = !loggedIn;

    if (!loggedIn) {
        // Nothing to suspend and nothing to log out of before the student is connected.
        $('actions').hidden = true;
        $('engineUrl').value = current.engineUrl;
        $('email').value = s.email || '';
        if (s.status.state === 'auth_error') showMessage(t('error.authRefused'), false);
        return;
    }

    showAccount(s.displayName, s.email);
    // The suspension is global: it is shown whether or not a document is open in this tab.
    current.paused = s.paused;
    $('pausedAlert').hidden = !s.paused;
    renderIconActions(s.paused);

    current.doc = await activeDocument();
    $('doc').hidden = !current.doc;
    $('noDoc').hidden = !!current.doc;
    if (!current.doc) return;

    const info = await chrome.runtime.sendMessage({ type: 'CERTIMENS_DOC_INFO', documentId: current.doc.id });
    if (!info.ok) showMessage(errorText(info), false);
    current.engineId = info.engineId || null;
    current.assignmentId = info.file?.assignment_id || null;
    await loadAssignments();
    if (info.file) {
        // removes any "NEW" badge from the tab: we fall back to the global badge
        try { await chrome.action.setBadgeText({ tabId: current.doc.tabId, text: null }); } catch (_) { /* nothing to remove */ }
        showLinked(info.file);
    } else {
        $('linked').hidden = true;
        $('create').hidden = false;
        $('createBtn').hidden = false;
        $('submit').hidden = true;
        $('documentName').value = current.doc.name;
    }
}

$('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const engineUrl = await requestEngineAccess($('engineUrl').value);
    if (!engineUrl) return;
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('login.connecting'), true);
    const res = await chrome.runtime.sendMessage({
        type: 'CERTIMENS_LOGIN',
        engineUrl,
        email: $('email').value.trim(),
        password: $('password').value,
    });
    button.disabled = false;
    if (!res.ok) {
        showMessage(errorText(res), false);
        return;
    }
    $('password').value = '';
    showMessage(t('login.loggedInAs', { email: res.me.email }), true);
    render();
});

$('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const doc = current.doc;
    if (!doc) return;
    const name = $('documentName').value.trim() || doc.name;
    const assignmentId = $('assignment').value;
    const button = $('createBtn');
    button.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_CREATE_FILE', documentId: doc.id, documentName: name, editorTitle: doc.name });
    if (!res.ok) {
        button.disabled = false;
        showMessage(errorText(res), false);
        return;
    }
    let file = null;
    if (assignmentId) file = await submitTo(res.engineId, assignmentId);
    button.disabled = false;
    if (assignmentId && !file) {
        render(); // file created but not submitted: the error message stays displayed
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

async function upload(button, payload) {
    const busy = (on) => { button.disabled = on; button.classList.toggle('disabled', on); };
    busy(true);
    showMessage(t('upload.sending'), true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_UPLOAD_DOCX', documentId: current.doc.id, ...payload });
    busy(false);
    if (!res.ok) {
        showMessage(res.status === 0 || res.status === 413 || res.status === 404
            ? t('upload.failed', { message: res.message })
            : errorText(res), false);
        return;
    }
    showMessage(t('upload.done'), true);
    showUpload(res.file);
}

// The Google Docs export is redirected to googleusercontent.com: Firefox, or Chrome when site
// access is restricted, only allows it after consent. request() is called directly in the
// click (Firefox requires it) and answers yes immediately if access is already granted.
$('exportDocx').addEventListener('click', () => {
    chrome.permissions.request({ origins: GOOGLE_EXPORT_ORIGINS }).then((granted) => {
        if (granted) upload($('exportDocx'), {});
        else showMessage(t('upload.exportDenied'), false);
    }, (err) => showMessage(t('error.permissionFailed', { message: err.message }), false));
});

$('docxFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A .docx is a zip archive: "PK" signature.
    if (!file.name.toLowerCase().endsWith('.docx') || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        showMessage(t('upload.notDocx'), false);
        return;
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    upload($('pickDocx'), { document: btoa(binary) });
});

$('logout').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_LOGOUT' });
    clearMessage();
    render();
});

$('pause').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_SET_PAUSED', paused: !current.paused });
    if (!res.ok) return showMessage(errorText(res), false);
    // Pausing already shows a permanent banner: confirming it on top put two red blocks one
    // under the other, saying the same thing in two wordings. Resuming leaves nothing on screen,
    // which is the one case where a confirmation tells the student something.
    if (res.paused) clearMessage();
    else showMessage(t('pause.resumed'), true);
    render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
