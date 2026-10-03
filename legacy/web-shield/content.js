// --- 1. EXTRACTION DE L'ID UNIQUE DU DOCUMENT ---
function extractDocumentId(url) {
    const googleDocsRegex = /\/document\/d\/([a-zA-Z0-9-_]+)/;
    const googleMatch = url.match(googleDocsRegex);
    if (googleMatch && googleMatch[1]) return "GDOCS-" + googleMatch[1];
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('sourcedoc')) return "WORD-" + urlParams.get('sourcedoc').replace(/[{}]/g, '');
    
    if (url.includes("sharepoint.com") || url.includes("officeapps.live.com") || url.includes("live.com")) {
        return "WORD-" + btoa(window.location.origin + window.location.pathname).substring(0, 25); 
    }
    return null;
}

// --- 2. SURVEILLANCE MILLIMÉTRÉE DU FOCUS ---
function notifyAgentFocus() {
    const docId = extractDocumentId(window.location.href);
    if (docId && document.hasFocus()) {
        chrome.runtime.sendMessage({ type: "DOCUMENT_FOCUS", documentId: docId });
    }
}

function notifyAgentBlur() {
    // L'étudiant a cliqué ailleurs (barre d'adresse, autre écran, etc.)
    chrome.runtime.sendMessage({ type: "DOCUMENT_BLUR" });
}

window.addEventListener('focus', notifyAgentFocus);
window.addEventListener('blur', notifyAgentBlur);

let lastUrl = location.href; 
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (document.hasFocus()) notifyAgentFocus();
    }
}).observe(document, {subtree: true, childList: true});

notifyAgentFocus();

// --- 3. LE BOUCLIER ANTI-VITESSE (TOAST UI) ---
function showCertimensToast(message, isSuccess = false) {
    let oldToast = document.getElementById("certimens-toast");
    if (oldToast) oldToast.remove();

    const toast = document.createElement("div");
    toast.id = "certimens-toast";
    toast.style.position = "fixed";
    toast.style.bottom = "30px";
    toast.style.right = "30px";
    toast.style.backgroundColor = isSuccess ? "#e6f4ea" : "#1E293B";
    toast.style.color = isSuccess ? "#137333" : "#ffffff";
    toast.style.border = isSuccess ? "2px solid #137333" : "2px solid #C5A059";
    toast.style.padding = "16px 24px";
    toast.style.borderRadius = "8px";
    toast.style.fontFamily = "sans-serif";
    toast.style.fontSize = "14px";
    toast.style.fontWeight = "bold";
    toast.style.zIndex = "999999";
    toast.style.boxShadow = "0 10px 25px rgba(0,0,0,0.15)";
    toast.style.transition = "opacity 0.3s ease-in-out";
    toast.style.maxWidth = "400px";
    toast.style.lineHeight = "1.5";
    toast.innerText = message;

    document.body.appendChild(toast);

    if (isSuccess) {
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 300);
        }, 8000); // 8 secondes pour bien lire l'avertissement
    }
}

// Écoute les ordres de notification venant du Background
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_TOAST_START") {
        showCertimensToast("🛡️ Certimens : Tatouage du fichier en cours. Veuillez patienter...");
    } else if (message.type === "SHOW_TOAST_SUCCESS") {
        // LE NOUVEAU MESSAGE D'AVERTISSEMENT
        showCertimensToast("✅ Fichier certifié !\n\n⚠️ ATTENTION : Si vous continuez à rédiger sur cette page, vous devrez obligatoirement retélécharger le document final avant de le rendre.", true);
    }
});// --- 1. EXTRACTION DE L'ID UNIQUE DU DOCUMENT ---
function extractDocumentId(url) {
    const googleDocsRegex = /\/document\/d\/([a-zA-Z0-9-_]+)/;
    const googleMatch = url.match(googleDocsRegex);
    if (googleMatch && googleMatch[1]) return "GDOCS-" + googleMatch[1];
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('sourcedoc')) return "WORD-" + urlParams.get('sourcedoc').replace(/[{}]/g, '');
    
    if (url.includes("sharepoint.com") || url.includes("officeapps.live.com") || url.includes("live.com")) {
        return "WORD-" + btoa(window.location.origin + window.location.pathname).substring(0, 25); 
    }
    return null;
}

// --- 2. SURVEILLANCE MILLIMÉTRÉE DU FOCUS ---
function notifyAgentFocus() {
    const docId = extractDocumentId(window.location.href);
    if (docId && document.hasFocus()) {
        chrome.runtime.sendMessage({ type: "DOCUMENT_FOCUS", documentId: docId });
    }
}

function notifyAgentBlur() {
    // L'étudiant a cliqué ailleurs (barre d'adresse, autre écran, etc.)
    chrome.runtime.sendMessage({ type: "DOCUMENT_BLUR" });
}

window.addEventListener('focus', notifyAgentFocus);
window.addEventListener('blur', notifyAgentBlur);

let lastUrl = location.href; 
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (document.hasFocus()) notifyAgentFocus();
    }
}).observe(document, {subtree: true, childList: true});

notifyAgentFocus();

// --- 3. LE BOUCLIER ANTI-VITESSE (TOAST UI) ---
function showCertimensToast(message, isSuccess = false) {
    let oldToast = document.getElementById("certimens-toast");
    if (oldToast) oldToast.remove();

    const toast = document.createElement("div");
    toast.id = "certimens-toast";
    toast.style.position = "fixed";
    toast.style.bottom = "30px";
    toast.style.right = "30px";
    toast.style.backgroundColor = isSuccess ? "#e6f4ea" : "#1E293B";
    toast.style.color = isSuccess ? "#137333" : "#ffffff";
    toast.style.border = isSuccess ? "2px solid #137333" : "2px solid #C5A059";
    toast.style.padding = "16px 24px";
    toast.style.borderRadius = "8px";
    toast.style.fontFamily = "sans-serif";
    toast.style.fontSize = "15px";
    toast.style.fontWeight = "bold";
    toast.style.zIndex = "999999";
    toast.style.boxShadow = "0 10px 25px rgba(0,0,0,0.15)";
    toast.style.transition = "opacity 0.3s ease-in-out";
    toast.innerText = message;

    document.body.appendChild(toast);

    if (isSuccess) {
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
}

// Écoute les ordres de notification venant du Background
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_TOAST_START") {
        showCertimensToast("🛡️ Certimens : Tatouage du fichier en cours. Veuillez patienter 3 secondes...");
    } else if (message.type === "SHOW_TOAST_SUCCESS") {
        showCertimensToast("✅ Fichier certifié ! Vous pouvez le déposer sur la plateforme.", true);
    }
});function extractDocumentId(url) {
    const googleDocsRegex = /\/document\/d\/([a-zA-Z0-9-_]+)/;
    const googleMatch = url.match(googleDocsRegex);
    if (googleMatch && googleMatch[1]) return "GDOCS-" + googleMatch[1];
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('sourcedoc')) return "WORD-" + urlParams.get('sourcedoc').replace(/[{}]/g, '');
    
    if (url.includes("sharepoint.com") || url.includes("officeapps.live.com") || url.includes("live.com")) {
        return "WORD-" + btoa(window.location.origin + window.location.pathname).substring(0, 25); 
    }
    return null;
}

// L'éclaireur annonce sa présence au Superviseur (uniquement s'il a bien le focus de l'écran)
function notifyAgent() {
    const docId = extractDocumentId(window.location.href);
    if (docId && document.hasFocus()) {
        chrome.runtime.sendMessage({ type: "DOCUMENT_FOCUS", documentId: docId });
    }
}

// 1. Au chargement de la page
notifyAgent();

// 2. Si l'étudiant reclique manuellement dans la page
window.addEventListener('focus', notifyAgent);

// 3. Quand le Superviseur (Background) demande : "Es-tu un document ?"
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CHECK_STATUS") {
        notifyAgent(); // L'éclaireur refait son check et répond
    }
});

// 4. Si l'étudiant navigue dans Google Docs sans recharger la page
let lastUrl = location.href; 
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        notifyAgent();
    }
}).observe(document, {subtree: true, childList: true});
