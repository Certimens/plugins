let currentDocId = null;
let lastActiveDocId = null;
let agentConnected = false;

// --- 1. COMMUNICATION AVEC L'AGENT PYTHON LOCAL ---
function envoyerAuServeurLocal(payload) {
    fetch('http://127.0.0.1:14567', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => {});
}

// Ping de vérification (Pare-feu)
setInterval(() => {
    fetch('http://127.0.0.1:14567', { method: 'OPTIONS' })
        .then(() => {
            if (!agentConnected) {
                chrome.action.setBadgeText({text: "ON"});
                chrome.action.setBadgeBackgroundColor({color: "#137333"});
                agentConnected = true;
            }
        })
        .catch(() => {
            if (agentConnected || agentConnected === undefined) {
                chrome.action.setBadgeText({text: "OFF"});
                chrome.action.setBadgeBackgroundColor({color: "#c5221f"});
                agentConnected = false;
            }
        });
}, 3000);

// --- 2. GESTION DU FOCUS ET DE L'ONGLIER ---
function stopperEnregistrement() {
    if (currentDocId !== null) {
        currentDocId = null;
        envoyerAuServeurLocal({ action: "CLEAR_DOC_ID" });
    }
}

function demarrerEnregistrement(docId) {
    if (currentDocId !== docId && agentConnected) {
        currentDocId = docId;
        lastActiveDocId = docId;
        envoyerAuServeurLocal({ action: "UPDATE_DOC_ID", documentId: docId });
    }
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === "DOCUMENT_FOCUS") {
        demarrerEnregistrement(message.documentId);
    } else if (message.type === "DOCUMENT_BLUR") {
        stopperEnregistrement();
    }
});

chrome.tabs.onActivated.addListener(() => stopperEnregistrement());
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) stopperEnregistrement();
});

// --- 3. INTERCEPTEUR DE TÉLÉCHARGEMENT (Tatouage) ---
chrome.downloads.onChanged.addListener((downloadDelta) => {
    if (downloadDelta.state && downloadDelta.state.current === "complete") {
        chrome.downloads.search({ id: downloadDelta.id }, (results) => {
            if (results && results.length > 0) {
                const fichier = results[0];
                const urlSource = fichier.url || fichier.finalUrl || "";
                
                if (fichier.filename.endsWith(".docx")) {
                    let docIdToTag = null;
                    const matchDocs = urlSource.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
                    const matchDrive = urlSource.match(/id=([a-zA-Z0-9-_]+)/);

                    if (matchDocs) docIdToTag = matchDocs[1];
                    else if (matchDrive && urlSource.includes("drive.google.com")) docIdToTag = matchDrive[1];
                    else if (lastActiveDocId !== null) docIdToTag = lastActiveDocId;

                    if (docIdToTag) {
                        // 1. Déclenche le tatouage côté Python
                        envoyerAuServeurLocal({
                            action: "TAG_DOWNLOAD",
                            documentId: docIdToTag,
                            filepath: fichier.filename
                        });

                        // 2. Affiche le Toast à l'étudiant pour le faire patienter
                        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                            if (tabs.length > 0) {
                                chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_TOAST_START" });
                                // Après 3.5 secondes (temps de traitement Python COM), on affiche le succès
                                setTimeout(() => {
                                    chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_TOAST_SUCCESS" });
                                }, 3500);
                            }
                        });
                    }
                }
            }
        });
    }
});
