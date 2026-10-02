// The ledger is the single source of truth. Dynamic lore is *derived* from it.
//
//   chat messages --(extraction)--> observations (each tagged with the signatures of the
//   messages that established it) --(derive, live messages only)--> entities/facts --> World Info
//
// A message signature is a hash of its role + text. Swiping, editing, deleting or branching
// changes which signatures are present in the active chat; observations whose source
// signatures are no longer present simply stop contributing ("dormant"), and they come back
// if the same text returns (e.g. swiping back).

import { hash } from './util.js';

export const LEDGER_VERSION = 1;
export const LEDGER_KEY = 'lore_ledger_v1';

export function newLedger(owner = '') {
    return {
        v: LEDGER_VERSION,
        owner,          // identity of the chat this ledger belongs to (chatMetadata.integrity)
        book: '',       // name of the dynamic World Info book (a *cache* of derived lore)
        ver: 0,         // bumped on every mutation
        nextObs: 1,
        scanned: {},    // message signature -> 1 (already processed by the extractor)
        obs: [],        // observations (see ingest.js)
        ents: {},       // per-entity user state: { protected, lock, status, mergeInto, name, type, notes }
        decisions: {},  // conflict decisions: pairKey -> 'new' | 'old' | 'both'
        written: {},    // entityId -> { uid, ch (content hash), kh (key hash), t }
        rejected: {},   // review mode: proposalKey -> 1
        pending: [],    // review mode: proposals awaiting approval
        log: [],        // change history (capped)
        runs: [],       // extraction run history (capped)
    };
}

export function migrateLedger(l) {
    if (!l || typeof l !== 'object') return newLedger();
    const base = newLedger(l.owner || '');
    const out = Object.assign(base, l);
    for (const k of ['scanned', 'ents', 'decisions', 'written', 'rejected']) if (!out[k] || typeof out[k] !== 'object') out[k] = {};
    for (const k of ['obs', 'pending', 'log', 'runs']) if (!Array.isArray(out[k])) out[k] = [];
    out.v = LEDGER_VERSION;
    return out;
}

/** Visible text of a message, whitespace-normalised. */
export const msgText = (m) => String(m?.mes ?? '').replace(/\s+/g, ' ').trim();

/** Signature of a message. Role + text only, so renaming the persona doesn't invalidate history. */
export const msgSig = (m) => hash(`${m?.is_user ? 'u' : 'a'}|${msgText(m)}`);

/**
 * The active chain: every real story message in order. System/hidden messages and empty
 * messages are skipped. `idx` is the position in SillyTavern's chat array.
 */
export function buildChain(chat) {
    const out = [];
    (chat || []).forEach((m, idx) => {
        if (!m || m.is_system) return;
        const text = msgText(m);
        if (!text) return;
        out.push({ idx, sig: msgSig(m), is_user: !!m.is_user, name: m.name || (m.is_user ? 'User' : 'Narrator'), text });
    });
    return out;
}

export function chainPositions(chain) {
    const pos = new Map();
    chain.forEach((c, i) => { if (!pos.has(c.sig)) pos.set(c.sig, i); });
    return pos;
}

export function logChange(ledger, entry, cap = 300) {
    ledger.log.push({ t: Date.now(), ...entry });
    if (ledger.log.length > cap) ledger.log.splice(0, ledger.log.length - cap);
    ledger.ver++;
}

/** Drop observations that have been dormant (no live source message) for too long. Returns count removed. */
export function pruneDormant(ledger, liveSigs, keepNewest = 4000) {
    const live = ledger.obs.filter(o => o.sigs.some(s => liveSigs.has(s)));
    const dormant = ledger.obs.filter(o => !o.sigs.some(s => liveSigs.has(s)));
    const keepDormant = Math.max(0, keepNewest - live.length);
    const keptDormant = dormant.slice(Math.max(0, dormant.length - keepDormant));
    const before = ledger.obs.length;
    const keep = new Set([...live, ...keptDormant]);
    ledger.obs = ledger.obs.filter(o => keep.has(o));
    ledger.ver++;
    return before - ledger.obs.length;
}
