// Lore Ledger - branch-aware, provenance-tracked dynamic lore for SillyTavern.
// All SillyTavern access goes through SillyTavern.getContext() (the supported extension API).
// The pure logic lives in ./core/* and is unit-tested in Node (see test/run-tests.mjs).

import { mergeSettings, TYPES } from './core/config.js';
import { LEDGER_KEY, newLedger, migrateLedger, buildChain, logChange, pruneDormant } from './core/ledger.js';
import { derive } from './core/derive.js';
import { buildRegistry } from './core/match.js';
import { ingestExtraction } from './core/ingest.js';
import { planOps, applyOps, rollbackLog, opKey } from './core/plan.js';
import { EXTRACTION_JSON_SCHEMA, parseModelJson } from './core/schema.js';
import { buildSystemPrompt, buildUserPrompt, buildKnownBlock, makeNonce } from './core/prompt.js';
import { hash, sanitizeText } from './core/util.js';

const MODULE = 'lore_ledger';
const FOLDER = 'third-party/SillyTavern-LoreLedger';
const BOOK_PREFIX = 'DynLore_';
const ctx = () => SillyTavern.getContext();
const log = (...a) => console.log('[LoreLedger]', ...a);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { busy: false, extracting: false, cancel: false, derived: null, chain: [], staticCache: new Map(), staticInfo: new Map(), lastErr: '', status: 'idle', warnedBind: false };
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn).catch(e => { console.error('[LoreLedger]', e); state.lastErr = String(e?.message || e); }));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------------------------------------------------------------- settings & ledger
function settings() {
    const { extensionSettings, saveSettingsDebounced } = ctx();
    extensionSettings[MODULE] = mergeSettings(extensionSettings[MODULE]);
    return { S: extensionSettings[MODULE], save: saveSettingsDebounced };
}
const S = () => settings().S;
const saveSettings = () => settings().save();

function chatOwner() {
    const c = ctx();
    return String(c.chatMetadata?.integrity || c.getCurrentChatId?.() || 'chat');
}
function expectedBookName() {
    const id = String(ctx().getCurrentChatId?.() || 'chat');
    return `${BOOK_PREFIX}${id.replace(/[^\w-]+/g, '_').slice(0, 40)}_${hash(chatOwner()).slice(0, 5)}`;
}

/** The ledger lives in chat metadata so it is saved with (and branches with) the chat file. */
function getLedger() {
    const c = ctx();
    if (!c.chatMetadata) return null;
    let L = c.chatMetadata[LEDGER_KEY];
    if (!L) { L = c.chatMetadata[LEDGER_KEY] = newLedger(chatOwner()); L.book = ''; }
    else if (L.v !== 1 || !Array.isArray(L.obs)) L = c.chatMetadata[LEDGER_KEY] = migrateLedger(L);
    // A branch/copy inherits the parent's ledger *including its book name*. Give it its own book.
    if (L.owner && L.owner !== chatOwner()) {
        const oldBook = L.book;
        L.owner = chatOwner(); L.book = ''; L.written = {}; L.pending = [];
        if (oldBook && c.chatMetadata.world_info === oldBook) delete c.chatMetadata.world_info;
        logChange(L, { kind: 'branch', why: `chat copied/branched; new dynamic book will be created (was ${oldBook || 'none'})` });
    }
    if (!L.owner) L.owner = chatOwner();
    return L;
}
const persistLedger = async () => { try { await ctx().saveMetadata(); } catch (e) { console.warn('[LoreLedger] saveMetadata failed', e); } };

// ---------------------------------------------------------------- world info access
function wi() {
    const c = ctx();
    if (!c.loadWorldInfo || !c.saveWorldInfo) throw new Error('This SillyTavern version does not expose loadWorldInfo/saveWorldInfo in getContext(); update SillyTavern.');
    return c;
}
function assertWritable(name, L) {
    const S_ = S();
    if (!name || name !== L.book || !name.startsWith(BOOK_PREFIX) || (S_.staticBooks || []).includes(name)) throw new Error(`Refusing to write to "${name}": only the extension-owned dynamic book may be modified.`);
}

async function ensureBook(L) {
    const c = wi();
    if (!L.book) L.book = expectedBookName();
    const names = c.getWorldInfoNames?.() || [];
    let created = false;
    if (!names.includes(L.book)) {
        const existing = await c.loadWorldInfo(L.book).catch(() => null);
        if (!existing) {
            assertWritable(L.book, L);
            await c.saveWorldInfo(L.book, { entries: {} }, true);
            await c.updateWorldInfoList?.();
            created = true;
        }
    }
    const bound = c.chatMetadata.world_info;
    if (!bound) { c.chatMetadata.world_info = L.book; await persistLedger(); c.reloadWorldInfoEditor?.(L.book, true); }
    else if (bound !== L.book && !state.warnedBind) {
        state.warnedBind = true;
        toastr.warning(`This chat already uses "${bound}" as its Chat Lorebook. Add "${L.book}" under World Info > Active World(s) for all chats (global), or it will not be injected.`, 'Lore Ledger', { timeOut: 15000 });
    }
    return created;
}

async function loadStatic(L) {
    const c = ctx(), S_ = S();
    const names = new Set(S_.staticBooks || []);
    if (S_.autoDetectStatic) {
        try { ($('#world_info').val() || []).forEach(n => names.add(n)); } catch { /* DOM optional */ }
        const ch = c.characters?.[c.characterId];
        const cw = ch?.data?.extensions?.world; if (cw) names.add(cw);
        const bound = c.chatMetadata?.world_info; if (bound && bound !== L.book) names.add(bound);
    }
    names.delete(L.book);
    for (const n of [...names]) if (String(n).startsWith(BOOK_PREFIX)) names.delete(n);
    const out = [], info = new Map();
    for (const n of names) {
        let data = state.staticCache.get(n);
        if (!data || Date.now() - data.t > 60000) {
            const d = await c.loadWorldInfo(n).catch(() => null);
            data = { t: Date.now(), d }; state.staticCache.set(n, data);
        }
        for (const [uid, e] of Object.entries(data.d?.entries || {})) {
            if (e.disable || !e.content) continue;
            const keys = (e.key || []).filter(Boolean);
            const name = (e.comment || keys[0] || '').toString().trim();
            if (!name && !keys.length) continue;
            const s = { id: `static:${n}:${e.uid ?? uid}`, name: name || keys[0], keys, content: String(e.content), type: 'other' };
            out.push(s); info.set(s.id, s);
        }
    }
    state.staticInfo = info;
    return out;
}

// ---------------------------------------------------------------- sync (derive -> plan -> apply)
async function sync({ apply = true } = {}) {
    const c = ctx();
    const L = getLedger();
    if (!L) return;
    const S_ = S();
    state.chain = buildChain(c.chat);
    const statics = await loadStatic(L);
    const d = derive(L, state.chain, S_, state.staticInfo);
    state.derived = d;
    state.statics = statics;
    if (!S_.enabled || !apply) return;

    await ensureBook(L);
    const book = await c.loadWorldInfo(L.book);
    if (!book) throw new Error(`Could not load dynamic book "${L.book}"`);
    const plan = planOps(L, d, S_, book);
    state.held = plan.held;
    let ops = plan.ops;
    if (S_.applyMode === 'review') {
        const fresh = ops.filter(o => !L.rejected[opKey(o)]);
        // non-destructive safety ops (lock/disable) apply immediately; creates/updates/removals wait for approval.
        // The render object is recomputed from derived state at approval time, so it is not stored.
        const safe = fresh.filter(o => o.type === 'lock' || o.type === 'disable');
        L.pending = fresh.filter(o => !safe.includes(o)).map(o => ({ ...o, k: opKey(o), R: undefined }));
        ops = safe;
    }
    if (ops.length) {
        assertWritable(L.book, L);
        applyOps(book, ops, S_, L);
        await c.saveWorldInfo(L.book, book, true);
        c.reloadWorldInfoEditor?.(L.book, true);
    }
    if (ops.length || S_.applyMode === 'review') await persistLedger();
}

async function approve(keys, { reject = false } = {}) {
    const c = ctx(), L = getLedger(), S_ = S();
    const picks = L.pending.filter(p => keys.includes(p.k));
    if (reject) { picks.forEach(p => { L.rejected[p.k] = 1; }); L.pending = L.pending.filter(p => !keys.includes(p.k)); await persistLedger(); return; }
    await ensureBook(L);
    const book = await c.loadWorldInfo(L.book);
    const d = derive(L, buildChain(c.chat), S_, state.staticInfo);
    const plan = planOps(L, d, S_, book);
    const want = new Set(picks.map(p => p.k));
    const ops = plan.ops.filter(o => want.has(opKey(o)));
    assertWritable(L.book, L);
    applyOps(book, ops, S_, L);
    L.pending = L.pending.filter(p => !want.has(p.k));
    await c.saveWorldInfo(L.book, book, true);
    c.reloadWorldInfoEditor?.(L.book, true);
    await persistLedger();
}

// ---------------------------------------------------------------- model call
async function callModel(system, user) {
    const c = ctx(), S_ = S();
    state.extracting = true;
    try {
        if (S_.connection === 'profile' && S_.profileId && c.ConnectionManagerRequestService) {
            const r = await c.ConnectionManagerRequestService.sendRequest(S_.profileId,
                [{ role: 'system', content: system }, { role: 'user', content: user }], S_.maxTokens, { stream: false, extractData: true, includePreset: false, includeInstruct: false });
            return typeof r === 'string' ? r : (r?.content ?? '');
        }
        const base = { systemPrompt: system, prompt: user, responseLength: S_.maxTokens };
        let out = await c.generateRaw({ ...base, ...(S_.useSchema ? { jsonSchema: EXTRACTION_JSON_SCHEMA } : {}) });
        if (S_.useSchema && (!out || !parseModelJson(out) || (parseModelJson(out) && !Array.isArray(parseModelJson(out).entities)))) {
            log('structured output unusable, retrying as plain JSON');
            out = await c.generateRaw(base);
        }
        return out;
    } finally { state.extracting = false; }
}

// ---------------------------------------------------------------- extraction
function setStatus(s) { state.status = s; $('#ll_status').text(s); }

async function extractBatches({ force = false, limit = Infinity } = {}) {
    const c = ctx(), S_ = S();
    if (!S_.enabled && !force) return 0;
    const L = getLedger(); if (!L || !c.chat?.length) return 0;
    let done = 0, calls = 0;
    while (calls < limit && !state.cancel) {
        const chain = buildChain(c.chat);
        const settled = chain.slice(0, Math.max(0, chain.length - (force ? 0 : S_.settleLag)));
        const todo = settled.map((m, i) => ({ ...m, i })).filter(m => !L.scanned[m.sig]);
        if (!todo.length || (!force && todo.length < S_.extractEvery)) break;
        const batch = todo.slice(0, S_.windowMax);
        const first = batch[0].i;
        const context = chain.slice(Math.max(0, first - S_.contextMsgs), first).map(m => ({ ...m, isContext: true }));
        const win = [...context, ...batch.map(m => ({ ...m, isContext: false }))].map((m, n) => ({ n: n + 1, sig: m.sig, is_user: m.is_user, name: m.name, text: m.text, isContext: !!m.isContext }));

        const statics = await loadStatic(L);
        const d = derive(L, chain, S_, state.staticInfo);
        const ents = [...d.ents.values()];
        const nonce = makeNonce();
        const known = buildKnownBlock(ents, statics, win.map(w => w.text).join(' '), S_);
        setStatus(`extracting ${done + 1}-${done + batch.length} of ${todo.length + done}…`);
        let raw;
        try { raw = await callModel(buildSystemPrompt(S_, nonce), buildUserPrompt(win, known, nonce, S_)); }
        catch (e) { state.lastErr = String(e?.message || e); L.runs.push({ t: Date.now(), ok: false, err: state.lastErr }); toastr.error(`Extraction failed: ${state.lastErr}`, 'Lore Ledger'); break; }
        if (!parseModelJson(raw)) {                               // don't mark messages scanned if we got garbage; try again later
            state.lastErr = 'model returned no parsable JSON';
            L.runs.push({ t: Date.now(), ok: false, err: state.lastErr });
            toastr.warning('The extraction model returned no usable JSON; will retry later.', 'Lore Ledger'); break;
        }
        const reg = buildRegistry(ents, statics);
        const res = ingestExtraction(L, win, raw, {
            registry: reg, protagonist: S_.protagonist, evidenceStrictness: S_.evidenceStrictness, knownFactIds: new Set(d.factIndex.keys()),
        });
        L.runs.push({ t: Date.now(), ok: true, n: batch.length, added: res.added, dropped: res.droppedCount });
        if (L.runs.length > 60) L.runs.splice(0, L.runs.length - 60);
        done += batch.length; calls++;
        await sync();
        await persistLedger();
    }
    setStatus(state.cancel ? 'cancelled' : 'idle'); state.cancel = false;
    return done;
}
const runExtraction = (opts) => enqueue(async () => { try { return await extractBatches(opts); } finally { renderDashboardIfOpen(); } });

const scheduleExtract = debounce(() => { if (!state.busy && S().enabled) runExtraction(); }, 4000);
const scheduleSync = debounce(() => enqueue(async () => { await sync(); renderDashboardIfOpen(); }), 1200);

// ---------------------------------------------------------------- dashboard
let popupOpen = false, activeTab = 'entities';
const renderDashboardIfOpen = () => { if (popupOpen) $('#ll_dash_body').html(dashHtml()); };

function dashHtml() {
    const L = getLedger(), S_ = S(), d = state.derived;
    if (!L || !d) return '<p>No chat loaded.</p>';
    const tabs = [['entities', 'Entities'], ['pending', `Pending (${L.pending.length})`], ['conflicts', `Conflicts (${d.conflicts.length})`], ['history', 'History'], ['tools', 'Tools']];
    const head = `<div class="ll-tabs">${tabs.map(([k, n]) => `<button class="menu_button ll-tab ${k === activeTab ? 'active' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>`;
    const meta = `<div class="ll-meta">Book: <b>${esc(L.book || '(not created yet)')}</b> · live observations: ${L.obs.filter(o => o.sigs.some(s => d.pos.has(s))).length}/${L.obs.length} · scanned messages: ${Object.keys(L.scanned).length}${state.lastErr ? ` · last error: ${esc(state.lastErr)}` : ''}</div>`;
    let body = '';
    if (activeTab === 'entities') {
        const rows = [...d.ents.values()].sort((a, b) => ({ promoted: 0, candidate: 1, excluded: 2, rejected: 3 }[a.state] - { promoted: 0, candidate: 1, excluded: 2, rejected: 3 }[b.state]) || b.impMax - a.impMax);
        body = `<table class="ll-table"><tr><th>Entity</th><th>Type</th><th>Status</th><th>Scenes</th><th>Imp</th><th>Conf</th><th>Why</th><th></th></tr>${rows.map(E => {
            const u = L.ents[E.id] || {};
            const flags = `${u.lock ? ' 🔒' : ''}${u.protected ? ' 🛡' : ''}${E.staticRef ? ' ↔static' : ''}`;
            return `<tr class="ll-${E.state}"><td title="${esc(E.facts.filter(f => f.state === 'active').map(f => `[${f.status}] ${f.text}`).join('\n'))}">${esc(E.name)}${flags}</td><td>${esc(E.type)}</td><td>${E.state}</td><td>${E.episodes}</td><td>${E.impMax.toFixed(1)}</td><td>${E.confMax.toFixed(2)}</td><td>${esc(E.reason)}</td>
              <td class="ll-actions" data-id="${esc(E.id)}"><a class="ll-act" data-act="promote">promote</a> <a class="ll-act" data-act="reject">reject</a> <a class="ll-act" data-act="lock">${u.lock ? 'unlock' : 'lock'}</a> <a class="ll-act" data-act="protect">${u.protected ? 'unprotect' : 'protect'}</a> <a class="ll-act" data-act="reset">reset</a></td></tr>`;
        }).join('') || '<tr><td colspan="8">Nothing observed yet. Play on, or run a manual scan from Tools.</td></tr>'}</table>
        <div class="ll-note">Hover a name to see its facts. "Scenes" counts separate episodes in which the entity appeared. 🔒 = automation will not edit its card. 🛡 = card is never removed automatically.</div>`;
    } else if (activeTab === 'pending') {
        body = L.pending.length ? `<div><button class="menu_button ll-bulk" data-act="approve-all">Approve all</button> <button class="menu_button ll-bulk" data-act="reject-all">Reject all</button></div>
          <table class="ll-table"><tr><th>Change</th><th>Entry</th><th>Proposed text</th><th>Why</th><th></th></tr>${L.pending.map(p => `<tr><td>${p.type}</td><td>${esc(p.name || p.id)}</td><td><pre>${esc(p.after?.content || '')}</pre></td><td>${esc(p.why)}</td><td class="ll-actions" data-k="${p.k}"><a class="ll-act" data-act="approve">approve</a> <a class="ll-act" data-act="reject-one">reject</a></td></tr>`).join('')}</table>` : '<p>No pending changes. (Review mode is set in the settings panel.)</p>';
    } else if (activeTab === 'conflicts') {
        body = d.conflicts.length ? `<table class="ll-table"><tr><th>Entity</th><th>Established</th><th>Newer, conflicting</th><th></th></tr>${d.conflicts.map(k => `<tr><td>${esc(k.entityName)} (${esc(k.slot)})</td><td>${esc(k.oldText)}</td><td>${esc(k.newText)}</td><td class="ll-actions" data-k="${k.key}"><a class="ll-act" data-act="dec-new">newer is right</a> <a class="ll-act" data-act="dec-old">keep established</a> <a class="ll-act" data-act="dec-both">keep both</a></td></tr>`).join('')}</table>` : '<p>No unresolved contradictions. (Conflict policy "ask" lists them here.)</p>';
    } else if (activeTab === 'history') {
        body = `<table class="ll-table"><tr><th>When</th><th>Change</th><th>Entry</th><th>Why</th><th></th></tr>${L.log.map((x, i) => ({ x, i })).reverse().slice(0, 150).map(({ x, i }) => `<tr><td>${new Date(x.t).toLocaleString()}</td><td>${esc(x.kind)}</td><td>${esc(x.name || x.id || '')}</td><td>${esc(x.why || '')}</td><td>${['create', 'update', 'remove', 'disable'].includes(x.kind) ? `<a class="ll-act" data-act="rollback" data-i="${i}">undo</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No changes yet.</td></tr>'}</table>`;
    } else {
        const unscanned = state.chain.filter(m => !L.scanned[m.sig]).length;
        const chars = state.chain.filter(m => !L.scanned[m.sig]).reduce((a, m) => a + m.text.length, 0);
        body = `<div class="ll-tools">
          <p><b>Unscanned messages:</b> ${unscanned} (~${Math.ceil(chars / 4).toLocaleString()} tokens of story in ~${Math.ceil(unscanned / S_.windowMax)} extraction calls, plus ~1.5k tokens of instructions per call).</p>
          <button class="menu_button ll-bulk" data-act="scan">Scan all unscanned messages now (first run on an existing story = whole history)</button>
          <button class="menu_button ll-bulk" data-act="cancel">Cancel running scan</button><hr>
          <button class="menu_button ll-bulk" data-act="rederive">Rebuild lore from ledger (free, no model calls)</button>
          <button class="menu_button ll-bulk" data-act="rescan">Forget ledger and rescan from scratch…</button><hr>
          <button class="menu_button ll-bulk" data-act="export">Export ledger</button>
          <label class="menu_button ll-bulk">Import ledger<input type="file" id="ll_import" accept=".json" hidden></label>
          <button class="menu_button ll-bulk" data-act="prune">Prune old dormant observations</button>
        </div>`;
    }
    return head + meta + `<div class="ll-body">${body}</div>`;
}

async function onAction($el) {
    const c = ctx(), L = getLedger(), act = $el.data('act');
    const id = $el.closest('[data-id]').data('id'), k = $el.closest('[data-k]').data('k');
    const setEnt = (patch) => { L.ents[id] = { ...(L.ents[id] || {}), ...patch }; logChange(L, { kind: 'user', id, why: JSON.stringify(patch) }); };
    await enqueue(async () => {
        switch (act) {
            case 'promote': setEnt({ status: 'promote' }); break;
            case 'reject': setEnt({ status: 'reject' }); break;
            case 'reset': setEnt({ status: undefined, lock: false, protected: false, keep: false }); break;
            case 'lock': setEnt({ lock: !L.ents[id]?.lock }); break;
            case 'protect': setEnt({ protected: !L.ents[id]?.protected }); break;
            case 'approve': await approve([k]); break;
            case 'reject-one': await approve([k], { reject: true }); break;
            case 'approve-all': await approve(L.pending.map(p => p.k)); break;
            case 'reject-all': await approve(L.pending.map(p => p.k), { reject: true }); break;
            case 'dec-new': L.decisions[k] = 'new'; break;
            case 'dec-old': L.decisions[k] = 'old'; break;
            case 'dec-both': L.decisions[k] = 'both'; break;
            case 'rollback': {
                const book = await c.loadWorldInfo(L.book); assertWritable(L.book, L);
                if (rollbackLog(book, L, Number($el.data('i')))) { await c.saveWorldInfo(L.book, book, true); c.reloadWorldInfoEditor?.(L.book, true); }
                break;
            }
            case 'rederive': break;
            case 'prune': { const n = pruneDormant(L, new Set(state.chain.map(m => m.sig)), 1500); toastr.info(`Removed ${n} dormant observations`, 'Lore Ledger'); break; }
            case 'cancel': state.cancel = true; return;
            case 'export': download(`lore-ledger-${chatOwner()}.json`, JSON.stringify({ ledger: L, settings: S() }, null, 1)); return;
            default: return;
        }
        await persistLedger(); await sync();
    });
    if (act === 'scan') runExtraction({ force: true });
    if (act === 'rescan') {
        const ok = await ctx().Popup.show.confirm('Rescan from scratch?', 'This deletes the observation ledger for this chat (the dynamic book is rebuilt from the rescan) and spends model tokens. Manual locks/protections are kept.');
        if (ok) { await enqueue(async () => { L.obs = []; L.scanned = {}; L.pending = []; logChange(L, { kind: 'rescan', why: 'ledger cleared by user' }); await persistLedger(); await sync(); }); runExtraction({ force: true }); }
    }
    renderDashboardIfOpen();
}
function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function openDashboard() {
    const { Popup, POPUP_TYPE } = ctx();
    await enqueue(() => sync({ apply: false }));
    popupOpen = true;
    const p = new Popup(`<div class="ll-dash"><h3>Lore Ledger</h3><div id="ll_dash_body">${dashHtml()}</div></div>`, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    await p.show();
    popupOpen = false;
}

// ---------------------------------------------------------------- settings panel
function bindSettings() {
    const S_ = S();
    $('#extensions_settings2 [data-ll]').each(function () {
        const $i = $(this), key = $i.data('ll'), v = S_[key];
        if ($i.is(':checkbox')) $i.prop('checked', !!v);
        else if ($i.is('[data-list]')) $i.val((v || []).join(', '));
        else $i.val(v ?? '');
    });
    $('#extensions_settings2').off('change.ll input.ll').on('change.ll', '[data-ll]', function () {
        const $i = $(this), key = $i.data('ll'), S2 = S();
        if ($i.is(':checkbox')) S2[key] = $i.prop('checked');
        else if ($i.is('[data-list]')) S2[key] = String($i.val()).split(',').map(x => x.trim()).filter(Boolean);
        else if ($i.attr('type') === 'number') S2[key] = Number($i.val());
        else S2[key] = $i.val();
        if (key === 'staticBooks' || key === 'autoDetectStatic') state.staticCache.clear();
        saveSettings();
        if (key === 'enabled') { if (S2.enabled) { scheduleSync(); scheduleExtract(); } }
        else scheduleSync();
    });
    // per-type rules
    const $t = $('#ll_type_rules').empty();
    for (const t of TYPES) {
        const r = S_.typeRules[t] || {};
        $t.append(`<tr><td>${t}</td><td><input type="checkbox" class="ll-tr" data-t="${t}" data-f="on" ${r.on ? 'checked' : ''}></td><td><input type="number" class="text_pole ll-tr" data-t="${t}" data-f="minAppearances" min="1" max="9" value="${r.minAppearances}"></td><td><input type="number" class="text_pole ll-tr" data-t="${t}" data-f="minImportance" min="0" max="10" value="${r.minImportance}"></td></tr>`);
    }
    $t.off('change').on('change', '.ll-tr', function () {
        const $i = $(this), S2 = S(), t = $i.data('t'), f = $i.data('f');
        S2.typeRules[t] = S2.typeRules[t] || {};
        S2.typeRules[t][f] = f === 'on' ? $i.prop('checked') : Number($i.val());
        saveSettings(); scheduleSync();
    });
    // Connection Manager profiles (optional extension)
    const profiles = ctx().extensionSettings?.connectionManager?.profiles || [];
    const $p = $('#ll_profile').empty().append('<option value="">(none)</option>');
    profiles.forEach(p => $p.append(`<option value="${esc(p.id)}">${esc(p.name)}</option>`));
    $p.val(S_.profileId || '');
}

// ---------------------------------------------------------------- init
jQuery(async () => {
    const c = ctx();
    const html = await c.renderExtensionTemplateAsync?.(FOLDER, 'settings');
    $('#extensions_settings2').append(html || '<div class="inline-drawer"><div class="inline-drawer-header"><b>Lore Ledger</b></div><div class="inline-drawer-content">settings.html not found</div></div>');
    bindSettings();
    $(document)
        .on('click', '#ll_open', openDashboard)
        .on('click', '#ll_scan_now', () => runExtraction({ force: true }))
        .on('click', '.ll-tab', function () { activeTab = $(this).data('tab'); renderDashboardIfOpen(); })
        .on('click', '.ll-act, .ll-bulk[data-act]', function () { onAction($(this)); })
        .on('change', '#ll_import', async function () {
            const f = this.files?.[0]; if (!f) return;
            try {
                const j = JSON.parse(await f.text()); const L = getLedger();
                const inc = migrateLedger(j.ledger || j); inc.owner = L.owner; inc.book = L.book; inc.written = L.written;
                c.chatMetadata[LEDGER_KEY] = inc; await persistLedger(); await enqueue(() => sync()); renderDashboardIfOpen(); toastr.success('Ledger imported', 'Lore Ledger');
            } catch (e) { toastr.error(`Import failed: ${e.message}`, 'Lore Ledger'); }
        });

    const E = c.eventTypes, es = c.eventSource, on = (ev, fn) => { if (ev) es.on(ev, fn); };
    on(E.GENERATION_STARTED, () => { if (!state.extracting) state.busy = true; });
    on(E.GENERATION_ENDED, () => { state.busy = false; scheduleExtract(); scheduleSync(); });
    on(E.GENERATION_STOPPED, () => { state.busy = false; scheduleSync(); });
    on(E.MESSAGE_RECEIVED, () => { scheduleSync(); scheduleExtract(); });
    for (const ev of [E.MESSAGE_EDITED, E.MESSAGE_DELETED, E.MESSAGE_SWIPED, E.MESSAGE_SENT, E.MESSAGE_UPDATED, E.MESSAGE_SWIPE_DELETED]) on(ev, scheduleSync);
    on(E.CHAT_CHANGED, () => { state.warnedBind = false; state.busy = false; state.staticCache.clear(); scheduleSync(); });
    on(E.WORLDINFO_UPDATED, () => state.staticCache.clear());

    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'lore-scan', helpString: 'Lore Ledger: extract lore from new messages now.', callback: async () => { const n = await runExtraction({ force: true }); return String(n || 0); }, returns: 'messages scanned' }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'lore-ledger', helpString: 'Open the Lore Ledger dashboard.', callback: async () => { openDashboard(); return ''; } }));
    } catch (e) { log('slash commands unavailable', e?.message); }
    scheduleSync();
    log('loaded');
});
