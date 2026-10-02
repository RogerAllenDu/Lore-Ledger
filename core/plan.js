// Reconcile derived entities with the dynamic World Info book.
// Rules: only entries whose comment starts with "DL:" are ever touched; only the fields
// key / content / comment / disable are changed on update; user-edited or locked entries are held.

import { render, parseManagedId } from './render.js';
import { hash } from './util.js';

export function newEntryTemplate(uid, R, S, displayIndex = 0) {
    return {
        uid,
        key: R.keys,
        keysecondary: [],
        comment: R.comment,
        content: R.content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: S.order ?? 100,
        position: S.position ?? 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: S.depth ?? 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: S.role ?? 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        displayIndex,
        characterFilter: { isExclude: false, names: [], tags: [] },
    };
}

const snap = (e) => e ? { content: e.content, key: [...(e.key || [])], comment: e.comment, disable: !!e.disable } : null;

/**
 * @returns {ops, held}  ops: [{type:'create'|'update'|'remove'|'disable'|'lock', id, uid?, before, after, why}]
 */
export function planOps(ledger, derived, S, bookData) {
    const entries = bookData?.entries || {};
    const managed = new Map();   // entityId -> {uid, entry}
    for (const [uid, e] of Object.entries(entries)) {
        const id = parseManagedId(e.comment);
        if (id) managed.set(id, { uid: Number(e.uid ?? uid), entry: e });
    }
    const ops = [], held = [];

    for (const E of derived.ents.values()) {
        const user = ledger.ents[E.id] || {};
        const cur = managed.get(E.id);
        if (E.state !== 'promoted') continue;
        const R = render(E, S);
        if (!R.keys.length) { held.push({ id: E.id, why: 'no usable keys' }); continue; }
        if (!cur) {
            ops.push({ type: 'create', id: E.id, name: E.name, before: null, after: { content: R.content, key: R.keys, comment: R.comment, disable: false }, R, why: E.reason });
            continue;
        }
        const w = ledger.written[E.id];
        const edited = w && (hash(cur.entry.content ?? '') !== w.ch || hash((cur.entry.key || []).join('|')) !== w.kh);
        if (user.lock || (edited && S.onManualEdit !== 'overwrite')) {
            held.push({ id: E.id, why: user.lock ? 'locked by user' : 'edited manually', name: E.name, R });
            if (edited && !user.lock) ops.push({ type: 'lock', id: E.id, name: E.name, before: snap(cur.entry), after: null, why: 'manual edit detected' });
            continue;
        }
        const keysChanged = (cur.entry.key || []).join('|') !== R.keys.join('|');
        if (cur.entry.content !== R.content || keysChanged || cur.entry.disable || cur.entry.comment !== R.comment) {
            ops.push({ type: 'update', id: E.id, uid: cur.uid, name: E.name, before: snap(cur.entry), after: { content: R.content, key: R.keys, comment: R.comment, disable: false }, R, why: 'facts changed' });
        }
    }

    // managed entries that are no longer justified by the active chat branch
    for (const [id, cur] of managed) {
        const E = derived.ents.get(id);
        if (E && E.state === 'promoted') continue;
        const user = ledger.ents[id] || {};
        if (user.keep) continue;                       // restored by a rollback: leave it alone
        const w = ledger.written[id];
        const edited = w && (hash(cur.entry.content ?? '') !== w.ch || hash((cur.entry.key || []).join('|')) !== w.kh);
        const why = !E ? 'its source messages are no longer in the active chat' : `no longer meets promotion rules (${E.reason})`;
        if (user.lock || user.protected || edited) {
            if (!cur.entry.disable) ops.push({ type: 'disable', id, uid: cur.uid, name: cur.entry.comment, before: snap(cur.entry), after: { ...snap(cur.entry), disable: true }, why: why + '; kept because it is locked/edited' });
        } else {
            ops.push({ type: 'remove', id, uid: cur.uid, name: cur.entry.comment, before: snap(cur.entry), after: null, why });
        }
    }
    return { ops, held };
}

/** Stable key identifying a proposal, so a rejected proposal isn't re-proposed forever. */
export const opKey = (op) => hash(`${op.type}|${op.id}|${op.after ? hash(op.after.content + '|' + op.after.key.join('|')) : 'x'}`);

/** Apply ops to the in-memory book object and bookkeeping in the ledger. Returns the number applied. */
export function applyOps(bookData, ops, S, ledger) {
    if (!bookData.entries) bookData.entries = {};
    const entries = bookData.entries;
    let applied = 0;
    const nextUid = () => Object.values(entries).reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;

    for (const op of ops) {
        const cur = op.uid != null ? entries[String(op.uid)] : null;
        if (op.type === 'create') {
            const uid = nextUid();
            entries[String(uid)] = newEntryTemplate(uid, op.R || { keys: op.after.key, content: op.after.content, comment: op.after.comment }, S, uid);
            ledger.written[op.id] = { uid, ch: hash(op.after.content), kh: hash(op.after.key.join('|')), t: Date.now() };
            op.uid = uid;
        } else if (op.type === 'update' && cur) {
            cur.content = op.after.content; cur.key = op.after.key; cur.comment = op.after.comment; cur.disable = false;
            ledger.written[op.id] = { uid: Number(cur.uid), ch: hash(op.after.content), kh: hash(op.after.key.join('|')), t: Date.now() };
        } else if (op.type === 'remove' && cur) {
            delete entries[String(op.uid)];
            delete ledger.written[op.id];
        } else if (op.type === 'disable' && cur) {
            cur.disable = true;
        } else if (op.type === 'lock') {
            ledger.ents[op.id] = { ...(ledger.ents[op.id] || {}), lock: true, lockReason: 'manual edit detected' };
        } else {
            continue;
        }
        applied++;
        ledger.log.push({ t: Date.now(), kind: op.type, id: op.id, name: op.name, why: op.why, before: op.before, after: op.after, uid: op.uid });
    }
    if (ledger.log.length > 300) ledger.log.splice(0, ledger.log.length - 300);
    ledger.ver++;
    return applied;
}

/** Undo one logged change. Returns true if something was restored. The entity is then locked so automation won't redo it. */
export function rollbackLog(bookData, ledger, logIndex) {
    const L = ledger.log[logIndex];
    if (!L || !L.id) return false;
    const entries = bookData.entries || (bookData.entries = {});
    const cur = L.uid != null ? entries[String(L.uid)] : null;
    if (L.kind === 'create' && cur) {
        delete entries[String(L.uid)]; delete ledger.written[L.id];
        ledger.ents[L.id] = { ...(ledger.ents[L.id] || {}), status: 'reject' };
    } else if ((L.kind === 'update' || L.kind === 'disable') && cur && L.before) {
        cur.content = L.before.content; cur.key = L.before.key; cur.comment = L.before.comment; cur.disable = L.before.disable;
        ledger.written[L.id] = { uid: Number(cur.uid), ch: hash(cur.content), kh: hash(cur.key.join('|')), t: Date.now() };
        ledger.ents[L.id] = { ...(ledger.ents[L.id] || {}), lock: true, keep: true, lockReason: 'rolled back' };
    } else if (L.kind === 'remove' && L.before) {
        const uid = Object.values(entries).reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
        entries[String(uid)] = newEntryTemplate(uid, { keys: L.before.key, content: L.before.content, comment: L.before.comment }, {}, uid);
        ledger.written[L.id] = { uid, ch: hash(L.before.content), kh: hash(L.before.key.join('|')), t: Date.now() };
        ledger.ents[L.id] = { ...(ledger.ents[L.id] || {}), lock: true, keep: true, lockReason: 'rolled back' };
    } else return false;
    ledger.log.push({ t: Date.now(), kind: 'rollback', id: L.id, name: L.name, why: `undid "${L.kind}"` });
    ledger.ver++;
    return true;
}
