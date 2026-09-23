// Word add-in task pane: student login, the open document's Certimens file,
// assignment submission and .docx upload (the counterpart of extension/popup.js). The page stays
// loaded when the task pane is closed (shared runtime): it is what keeps the measurement running.

let current = { docId: null, fileId: null, assignmentId: null };

function formatDeadline(iso) {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
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
        Object.assign(document.createElement('option'), { value: '', textContent: current.fileId ? '— Choisir un devoir —' : '— Aucun devoir pour l\'instant —' }),
        ...assignments.map((a) => Object.assign(document.createElement('option'), {
            value: a.id,
            textContent: `${a.title} (${new Date(a.deadline) < new Date() ? 'échu le' : 'avant le'} ${formatDeadline(a.deadline)})`,
        })),
    );
    select.value = current.assignmentId || '';
    $('assignmentBox').hidden = assignments.length === 0;
}

function showLinked(file) {
    current.fileId = file.id;
    current.assignmentId = file.assignment_id;
    $('create').hidden = true;
    $('createBtn').hidden = true;
    $('linked').hidden = false;
    $('linkedName').textContent = file.document_name;
    $('open').href = `${trimUrl(getConfig().engineUrl)}/file/${file.id}`;
    $('submitted').hidden = !file.assignment_id;
    $('submitted').textContent = file.assignment_title ? `Rendu sur : ${file.assignment_title}` : 'Rendu sur un devoir';
    $('uploadHint').textContent = file.content_type ? 'Un document est déjà envoyé : un nouvel envoi le remplace.' : '';
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
    $('submit').hidden = !current.fileId || $('assignmentBox').hidden || !chosen || chosen === current.assignmentId;
    $('submit').textContent = current.assignmentId ? 'Changer de devoir' : 'Rendre sur ce devoir';
}

function renderSync() {
    const { queue, status } = getState();
    const labels = {
        synced: 'Mesures à jour.',
        offline: `Moteur injoignable : ${queue.length} mesure(s) en attente, renvoi automatique.`,
        auth_error: 'Identifiants refusés par le moteur.',
        unconfigured: 'Non connecté : les mesures sont gardées jusqu\'à la connexion.',
    };
    $('sync').textContent = labels[status.state] || (queue.length ? `${queue.length} mesure(s) en attente.` : '');
}

async function submitTo(fileId, assignmentId) {
    try {
        return await submitFile(fileId, assignmentId);
    } catch (err) {
        showMessage(err.status === 403 ? `Rendu impossible : ${err.message}.` : errorText(failure(err)), false);
        return null;
    }
}

async function render() {
    const config = getConfig();
    const loggedIn = !!(config.token || config.password) && getState().status.state !== 'auth_error';
    $('login').hidden = loggedIn;
    $('account').hidden = !loggedIn;
    renderSync();

    if (!loggedIn) {
        $('engineUrl').value = config.engineUrl;
        $('email').value = config.email || '';
        if (getState().status.state === 'auth_error') showMessage('Identifiants refusés : reconnectez-vous.', false);
        return;
    }

    $('who').textContent = config.email;
    let info = { fileId: null, file: null };
    try {
        info = await docInfo(current.docId);
    } catch (err) {
        showMessage(errorText(failure(err)), false);
    }
    current.fileId = info.fileId || null;
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
    showMessage('Connexion…', true);
    try {
        const me = await login({
            engineUrl: $('engineUrl').value.trim() || DEFAULT_ENGINE_URL,
            email: $('email').value.trim(),
            password: $('password').value,
        });
        $('password').value = '';
        showMessage(`Connecté en tant que ${me.email}.`, true);
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
    if (assignmentId) file = await submitTo(res.fileId, assignmentId);
    button.disabled = false;
    if (assignmentId && !file) {
        render(); // file created but not submitted: the error message stays on screen
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

$('uploadDocx').addEventListener('click', async () => {
    const button = $('uploadDocx');
    button.disabled = true;
    showMessage('Envoi du document…', true);
    try {
        const file = await uploadDocx(current.docId);
        showMessage('Document envoyé.', true);
        showLinked(file);
    } catch (err) {
        showMessage(err.status === 0 || err.status === 413 || err.status === 404 ? `Envoi impossible : ${err.message}.` : errorText(failure(err)), false);
    }
    button.disabled = false;
});

$('logout').addEventListener('click', async () => {
    await logout();
    clearMessage();
    render();
});

Office.onReady(async (info) => {
    if (info.host !== Office.HostType.Word) return;
    current.docId = documentId();
    $('webNote').hidden = !isWordOnline();
    onStatusChange(renderSync);
    startAgent();
    render();
    try {
        await startSensor();
    } catch (err) {
        console.warn('Certimens : mesure indisponible.', err);
        showMessage('Mesure indisponible dans cette version de Word.', false);
    }
});
