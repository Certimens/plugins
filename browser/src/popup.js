// Popup: student login and creation of the Certimens document for the open document
// (Google Docs or Word Online).

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

// frozen: the deadline of the assignment this document answers has gone by. The engine then
// refuses the name, the assignment and the content of the copy — so the popup stops offering
// them rather than offering a button whose refusal the student can do nothing about. It is a
// date, not a state: pushing the deadline reopens all three, and the next render says so.
const current = { engineUrl: DEFAULT_ENGINE_URL, doc: null, engineId: null, assignmentId: null, frozen: false, paused: false };

// The picker itself is ui.js's, shared with the task pane: here, only where the list comes
// from — the service worker, which holds the session.
async function loadAssignments() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_ASSIGNMENTS' });
    renderAssignments(res.ok ? res.assignments : [], current);
}

function showLinked(file) {
    current.engineId = file.id;
    current.assignmentId = file.assignment_id;
    current.frozen = deadlinePassed(file.assignment_deadline);
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.name;
    $('open').href = `${current.engineUrl}/document/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title
        ? t('doc.submittedTo', { title: file.assignment_title })
        : t('doc.submittedGeneric');
    $('deadlineAlert').hidden = !current.frozen;
    showUpload(file);
    updateSubmitButton(current);
}

// How the copy is deposited, which is the editor's business and not the popup's: Google Docs
// exports it, Word Online and Overleaf cannot reach the file so the student picks a downloaded
// copy, and a page added by the student holds its copy in the page itself. One control each.
const DEPOSIT_CONTROL = { export: 'exportDocx', pick: 'pickDocx', text: 'sendText' };
const DEPOSIT_HINT = { export: null, pick: 'doc.wordSaveHint', text: 'doc.textHint' };

function showUpload(file) {
    const deposit = current.doc?.deposit || 'pick';
    for (const [mode, id] of Object.entries(DEPOSIT_CONTROL)) {
        $(id).hidden = current.frozen || mode !== deposit;
    }
    $('uploadHint').textContent = current.frozen ? '' : [
        file.content_type ? t('doc.alreadyUploaded') : null,
        // Saying which platform was recognised is what tells the student that "this page" is
        // the right page, before they press a button that sends what they wrote.
        current.doc?.platform ? t('doc.platform', { platform: current.doc.platform }) : null,
        DEPOSIT_HINT[deposit] ? t(DEPOSIT_HINT[deposit]) : null,
    ].filter(Boolean).join(' ');
}

async function submitTo(engineId, assignmentId) {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_SUBMIT_FILE', engineId, assignmentId });
    if (!res.ok) {
        showMessage(res.status === 403 ? t('submit.refused', { message: res.message }) : errorText(res), false);
        return null;
    }
    return res.file;
}

// --- MEASURING A PAGE THE EXTENSION DOES NOT KNOW ---
//
// The manifest names three editors. Everywhere else — a Moodle, a Canvas, a wiki — nothing is
// declared in advance: the student says "this is where I write" **from the page itself**, one
// click, one permission for this origin, and the sensor starts without even a reload. The
// options page keeps the list, to look at it and to take an address back.
//
// Asking for `https://*/*` once and measuring everywhere would have been simpler, and it is the
// wrong trade: a sensor on every page would open a measurement window in a webmail, a private
// forum, a bank's message box — and would create an engine document for each. Counters only is
// a promise about what leaves the machine, not a licence to watch everything on it.
const KNOWN_EDITOR_HOST = /(^|\.)docs\.google\.com$|(^|\.)overleaf\.com$|\.officeapps\.live\.com$|\.cloud\.microsoft$/;

// The address of the page, which `activeTab` hands over only because the student opened this
// popup — that is the gesture. Null when there is nothing to offer: an internal page, an
// editor we already know, a site already added.
async function pageToOffer() {
    if (!chrome.scripting?.registerContentScripts) return null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    let url;
    try {
        url = new URL(tab.url);
    } catch (_) {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (KNOWN_EDITOR_HOST.test(url.hostname)) return null;
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_SITES' });
    const match = url.origin + '/*';
    if (res?.ok && res.sites.includes(match)) return null;
    return { tabId: tab.id, match, host: url.hostname };
}

async function offerToMeasure() {
    current.offer = await pageToOffer();
    $('measureHere').hidden = !current.offer;
    if (current.offer) $('measureHere').title = t('sites.measureHereTip', { host: current.offer.host });
}

$('measureHere').addEventListener('click', async () => {
    const offer = current.offer;
    if (!offer) return;
    try {
        if (!await chrome.permissions.request({ origins: [offer.match] })) {
            showMessage(t('sites.denied'), false);
            return;
        }
    } catch (err) {
        showMessage(t('error.permissionFailed', { message: err.message }), false);
        return;
    }
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_ADD_SITE', match: offer.match });
    // The registration only covers the next load: this page is already open, and asking the
    // student to reload the page they are writing on would be asking them to lose their place.
    try {
        await chrome.scripting.executeScript({ target: { tabId: offer.tabId }, files: ['content.js'] });
    } catch (_) { /* the page will carry the sensor on its next load */ }
    showMessage(t('sites.added', { host: offer.host }), true);
    render();
});

async function render() {
    const s = await chrome.runtime.sendMessage({ type: 'CERTIMENS_STATUS' });
    // The account's language, as soon as it is known; the browser's until then.
    startLanguage(s);
    // After the language and not before: the notice is a sentence. Harmless on the renders that
    // follow — the first one consumes it, and the next ones find nothing to say. Whichever of
    // the two windows the student opens first is the one that says it.
    void showUpdateIfNew();
    current.engineUrl = s.engineUrl || DEFAULT_ENGINE_URL;
    const loggedIn = s.configured && s.status.state !== 'auth_error';
    $('login').hidden = loggedIn;
    $('account').hidden = !loggedIn;

    if (!loggedIn) {
        // A pairing may be waiting: the student asked for a code, went to confirm it, and is
        // back. Picked up here rather than only on the alarm, so coming back finishes it.
        void resumePairing();
        // A session the engine refuses is still a session held here, and its log out is the only
        // way to end it: pairing again writes a second token over the first, which stays live
        // until somebody revokes it from the Certimens space. Before any pairing there is
        // nothing to end, and the header stays empty.
        if (s.configured) renderIconActions(s.paused, false);
        else $('actions').hidden = true;
        fillEngineUrl(current.engineUrl);
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
    if (!current.doc) {
        await offerToMeasure();
        return;
    }

    const info = await chrome.runtime.sendMessage({ type: 'CERTIMENS_DOC_INFO', documentId: current.doc.id });
    if (!info.ok) showMessage(errorText(info), false);
    current.engineId = info.engineId || null;
    current.assignmentId = info.file?.assignment_id || null;
    // Read before the assignments are listed: a frozen copy hides the picker along with the rest.
    current.frozen = deadlinePassed(info.file?.assignment_deadline);
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

// Asks the engine for a code and shows it. The confirmation happens in the Certimens space, in
// another tab — so this popup will be closed while it happens, and the background is what waits.
$('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const engineUrl = await requestEngineAccess(engineUrlValue());
    if (!engineUrl) return;
    const button = e.submitter;
    button.disabled = true;
    showMessage(t('pair.asking'), true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_START', engineUrl });
    button.disabled = false;
    if (!res.ok) {
        showMessage(errorText(res), false);
        return;
    }
    showPairing(res.pairing);
});

$('pairCancel').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_CANCEL' });
    showPairing(null);
    showMessage('', true);
});

// Draws a pairing in flight, or puts the card back to its initial state when there is none.
function showPairing(pairing) {
    $('pairing').hidden = !pairing;
    $('pairStart').hidden = !!pairing;
    $('advanced').hidden = !!pairing;
    if (!pairing) return;
    $('userCode').textContent = pairing.userCode;
    $('pairOpen').href = pairing.verificationUriComplete;
    showMessage(t('pair.showCode'), true);
}

// Picks a pairing back up every time the popup opens: the student confirmed the code in another
// tab and came back here, and this is what finishes the connection on the spot rather than at
// the next minute's alarm.
async function resumePairing() {
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_PAIR_STATE' });
    if (!res.ok) {
        showPairing(null);
        showMessage(errorText(res), false);
        return;
    }
    if (res.me) {
        showPairing(null);
        showMessage(t('pair.connectedAs', { email: res.me.display_name || res.me.email }), true);
        render();
        return;
    }
    showPairing(res.pairing);
}

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

async function upload(button, payload) {
    const busy = (on) => { button.disabled = on; button.classList.toggle('disabled', on); };
    busy(true);
    showMessage(t('upload.sending'), true);
    const res = await chrome.runtime.sendMessage({ type: 'CERTIMENS_UPLOAD_DOCX', documentId: current.doc.id, ...payload });
    busy(false);
    if (!res.ok) {
        // 403 is the deadline having gone by, worded by the agent: it belongs with the refusals
        // the student reads as a sentence, not with "engine unreachable".
        showMessage(res.status === 0 || res.status === 403 || res.status === 413 || res.status === 404
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

// The copy of a page the student added: it is in the page, not in a file. Asked for at the
// moment of the click and never before — this is the one thing a measured page ever hands over,
// and it is the same explicit deposit as the .docx elsewhere.
$('sendText').addEventListener('click', async () => {
    let text = null;
    try {
        const res = await chrome.tabs.sendMessage(current.doc.tabId, { type: 'CERTIMENS_PAGE_TEXT' });
        text = res?.text ?? null;
    } catch (_) { /* the page no longer carries the sensor */ }
    if (!text || !text.trim()) {
        showMessage(t('upload.noText'), false);
        return;
    }
    // UTF-8 before base64: btoa alone refuses anything a French dissertation is full of.
    upload($('sendText'), { document: btoa(String.fromCharCode(...new TextEncoder().encode(text))) });
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
