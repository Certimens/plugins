// Popup: student login and creation of the Certimens file for the open document
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

let current = { engineUrl: DEFAULT_ENGINE_URL, doc: null, fileId: null, assignmentId: null };

function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// The student's assignments, sorted by deadline; overdue assignments stay listed but flagged.
async function loadAssignments() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_ASSIGNMENTS' });
    const select = $('assignment');
    const assignments = res.ok ? res.assignments : [];
    assignments.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    select.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: current.fileId ? '— Choisir un devoir —' : '— Aucun devoir pour l\'instant —' }),
        ...assignments.map((a) => Object.assign(document.createElement('option'), {
            value: a.id,
            textContent: `${a.title} (${new Date(a.deadline) < new Date() ? 'échu le' : 'avant le'} ${formatDeadline(a.deadline)})`,
        })),
    );
    select.value = current.assignmentId || '';
    $('assignmentBox').hidden = assignments.length === 0;
    return assignments;
}

function showLinked(file) {
    current.fileId = file.id;
    current.assignmentId = file.assignment_id;
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.document_name;
    $('open').href = `${current.engineUrl}/file/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title ? `Rendu sur : ${file.assignment_title}` : 'Rendu sur un devoir';
    showUpload(file);
    updateSubmitButton();
}

function showUpload(file) {
    const canExport = !!current.doc?.canExport;
    $('exportDocx').hidden = !canExport;
    $('pickDocx').hidden = canExport;
    $('uploadHint').textContent = [
        file.content_type ? 'Un document est déjà envoyé : un nouvel envoi le remplace.' : null,
        canExport ? null : 'Dans Word : Fichier › Enregistrer sous › Télécharger une copie, puis choisissez ce fichier.',
    ].filter(Boolean).join(' ');
}

function updateSubmitButton() {
    const chosen = $('assignment').value;
    $('submit').hidden = !current.fileId || $('assignmentBox').hidden || !chosen || chosen === current.assignmentId;
    $('submit').textContent = current.assignmentId ? 'Changer de devoir' : 'Rendre sur ce devoir';
}

async function submitTo(fileId, assignmentId) {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_SUBMIT_FILE', fileId, assignmentId });
    if (!res.ok) {
        showMessage(res.status === 403 ? `Rendu impossible : ${res.message}.` : errorText(res), false);
        return null;
    }
    return res.file;
}

async function render() {
    const s = await chrome.runtime.sendMessage({ type: 'CERTIMENS_STATUS' });
    current.engineUrl = s.engineUrl || DEFAULT_ENGINE_URL;
    const loggedIn = s.configured && s.status.state !== 'auth_error';
    $('login').hidden = loggedIn;
    $('account').hidden = !loggedIn;

    if (!loggedIn) {
        $('engineUrl').value = current.engineUrl;
        $('email').value = s.email || '';
        if (s.status.state === 'auth_error') showMessage('Identifiants refusés : reconnectez-vous.', false);
        return;
    }

    $('who').textContent = s.email;
    current.doc = await activeDocument();
    $('doc').hidden = !current.doc;
    $('noDoc').hidden = !!current.doc;
    if (!current.doc) return;

    const info = await chrome.runtime.sendMessage({ type: 'CERTIMENS_DOC_INFO', documentId: current.doc.id });
    if (!info.ok) showMessage(errorText(info), false);
    current.fileId = info.fileId || null;
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
    showMessage('Connexion…', true);
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
    showMessage(`Connecté en tant que ${res.me.email}.`, true);
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
    if (assignmentId) file = await submitTo(res.fileId, assignmentId);
    button.disabled = false;
    if (assignmentId && !file) {
        render(); // file created but not submitted: the error message stays displayed
        return;
    }
    showMessage(res.existed ? 'Ce document avait déjà un fichier.' : (file ? 'Fichier créé et rendu.' : 'Fichier créé.'), true);
    render();
});

$('assignment').addEventListener('change', updateSubmitButton);

$('submit').addEventListener('click', async () => {
    const button = $('submit');
    button.disabled = true;
    const file = await submitTo(current.fileId, $('assignment').value);
    button.disabled = false;
    if (!file) return;
    showMessage('Fichier rendu.', true);
    render();
});

async function upload(button, payload) {
    const busy = (on) => { button.disabled = on; button.classList.toggle('disabled', on); };
    busy(true);
    showMessage('Envoi du document…', true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_UPLOAD_DOCX', documentId: current.doc.id, ...payload });
    busy(false);
    if (!res.ok) {
        showMessage(res.status === 0 || res.status === 413 || res.status === 404 ? `Envoi impossible : ${res.message}.` : errorText(res), false);
        return;
    }
    showMessage('Document envoyé.', true);
    showUpload(res.file);
}

// The Google Docs export is redirected to googleusercontent.com: Firefox, or Chrome when site
// access is restricted, only allows it after consent. request() is called directly in the
// click (Firefox requires it) and answers yes immediately if access is already granted.
$('exportDocx').addEventListener('click', () => {
    chrome.permissions.request({ origins: GOOGLE_EXPORT_ORIGINS }).then((granted) => {
        if (granted) upload($('exportDocx'), {});
        else showMessage("Autorisation refusée : l'extension ne peut pas lire l'export Google Docs.", false);
    }, (err) => showMessage(`Autorisation impossible : ${err.message}`, false));
});

$('docxFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A .docx is a zip archive: "PK" signature.
    if (!file.name.toLowerCase().endsWith('.docx') || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        showMessage("Ce fichier n'est pas un document .docx.", false);
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

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
