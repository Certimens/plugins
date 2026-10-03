// What the extension keeps on the student's machine, written once.
//
// `chrome.storage.local` is a bag of keys with no shape of its own: every read of it was, until
// here, a guess that nothing checked. This file is that shape, and it is the only description of
// it there is — `background.js` writes it, `popup.js`, `options.js` and `content.js` read it.
//
// It is not shipped: a package is `src/` plus the licence, and this file sits outside it. It is
// read by the type checker alone (`npm run lint:types`), which is also why it is the one `.ts`
// in an agent that has no TypeScript in it.

/** The Certimens account, and how to reach its engine. Written at pairing, cleared at logout. */
interface CertimensConfig {
    engineUrl: string;
    email: string;
    /** Computed by the engine; falls back to the e-mail when the account has no name. */
    displayName: string;
    /** API token obtained by pairing, kept in place of a password — none is ever asked for. */
    token: string;
    /** Its id, so logging out revokes this token rather than leaving it live. */
    tokenId: string;
    /** The account's own language, read from GET /api/auth/me at pairing. */
    language: string;
}

/** A device-authorization exchange in progress (RFC 8628). Cleared on success or failure. */
interface CertimensPairing {
    deviceCode?: string;
    userCode?: string;
    verificationUri?: string;
    /** The API token, between the poll that returned it and the two calls that adopt it. */
    token?: string;
    expiresAt?: number;
    engineUrl?: string;
    [key: string]: unknown;
}

/** Where the last send got to. `state` is what the badge and the windows read. */
interface CertimensStatus {
    state?: string;
    at?: string;
    /** On a failure: whether the engine answered at all. Only an outage stamps a window `offline`. */
    reached?: boolean;
    [key: string]: unknown;
}

interface CertimensStored {
    config?: Partial<CertimensConfig>;
    /** Document id in the editor → document id on the engine. */
    engineIds?: Record<string, string>;
    /** Title last seen in the editor, and title last sent to the engine. */
    titles?: Record<string, string>;
    syncedTitles?: Record<string, string>;
    /**
     * Measurement windows waiting to be sent, each `{documentId, documentName, session, window,
     * offline?}` with `window` in the shape the engine reads. Bounded (MAX_QUEUE). An entry in
     * any other shape is dropped when the queue drains.
     */
    queue?: any[];
    /**
     * How many windows at the head of `queue` have already reached the engine. Moving a number
     * between two sends is what keeps a window from ever being pushed twice without rewriting
     * the whole queue to say so; the array is compacted when a measurement is queued and when a
     * drain empties it.
     */
    queueSent?: number;
    status?: CertimensStatus;
    /**
     * What the student's school proposes to measure, as read from the engine, with the moment
     * it was read. It proposes and never grants: each address still goes through the browser's
     * own permission dialog, from the options page. Absent until the first read, and kept when
     * a read fails — a school's addresses must not leave the page because the network did.
     */
    proposedSites?: { sites: string[]; at: number };
    /** Measurement suspended by the student. Global to the agent, not per document. */
    paused?: boolean;
    /**
     * Whether a session is open. Not a credential and never one: it says that a token exists,
     * not whose, which is all a content script needs to know whether what it is about to count
     * belongs to anybody. Written at pairing and at logout, read in every measured page.
     */
    signedIn?: boolean;
    /**
     * The version the student was last shown. Absent means a fresh install, never an old one:
     * the notice is skipped and the key written, so the first "Certimens has been updated" is
     * the one after the next update (pages.js, showUpdateIfNew).
     */
    seenVersion?: string;
    pairing?: CertimensPairing | null;
    /** Match patterns of the sites the student declared they write on. */
    sites?: string[];
    debug?: boolean;
    debugLog?: any[];
    /**
     * What the agent counts about itself (background.js, SELF-TELEMETRY): a word of
     * TELEMETRY_EVENTS → how many times, capped at TELEMETRY_MAX_COUNT. Never text. Not account
     * state: signing out keeps it.
     */
    telemetry?: Record<string, number>;
    /**
     * Where the extension's own code broke (background.js, `countRuntimeError`): at most
     * TELEMETRY_MAX_FAULTS distinct faults, each a type, the extension's own frames as
     * `function@file.js:line:column` and a count. Never a message. Sent and forgotten with the
     * counters.
     */
    telemetryFaults?: { type: string, frames: string[], count: number }[];
    /** When the counters were last sent (or tried), so they leave at most every TELEMETRY_FLUSH_MS. */
    telemetryAt?: number;
}

/** `chrome.storage.session`: what must not survive the browser. */
interface CertimensSession {
    /** Documents the popup has already offered to track, so it offers once per session. */
    prompted?: string[];
    /** `started` has been counted for this run of the extension (background.js, noteStarted). */
    telemetryStarted?: boolean;
}
