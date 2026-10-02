// derive(): pure function from (ledger, active chain, settings, static info) -> entities + facts.
// Nothing here is stored; the result is rebuilt whenever the chat changes, which is what makes
// swipes, edits, deletions, rewinds and branches consistent "for free".

import { chainPositions } from './ledger.js';
import { norm, hash, similarText, containment, contentTokens, uniq } from './util.js';
import { DEFAULT_SETTINGS } from './config.js';

export const factId = (entityId, text) => 'F' + hash(`${entityId}|${norm(text)}`).slice(0, 5);

const STATUS_RANK = { confirmed: 3, claim: 2, rumor: 2, unresolved: 1, plan: 1 };

function countBy(arr) {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
}
function topKey(map, prefer) {
    let best = null, bc = -1;
    for (const [k, c] of map) if (c > bc || (c === bc && prefer && prefer(k))) { best = k; bc = c; }
    return best;
}

/** Group sorted chain positions into episodes separated by >= gap absent messages. */
export function episodesOf(positions, gap) {
    const p = [...positions].sort((a, b) => a - b);
    let n = 0, prev = -Infinity;
    for (const x of p) { if (x - prev > gap) n++; prev = x; }
    return n;
}

/**
 * @param ledger
 * @param chain      buildChain() of the ACTIVE chat
 * @param S          settings
 * @param staticInfo Map<staticId, {name, keys, content}>
 */
export function derive(ledger, chain, S = DEFAULT_SETTINGS, staticInfo = new Map()) {
    const pos = chainPositions(chain);
    const live = (s) => pos.has(s);
    const ents = new Map();
    const factIndex = new Map();
    const conflicts = [];

    const resolveId = (id) => {           // follow user merges
        let hops = 0;
        while (ledger.ents[id]?.mergeInto && hops++ < 8) id = ledger.ents[id].mergeInto;
        return id;
    };

    // 1. live observations in chronological order (by current chain position)
    const liveObs = [];
    for (const o of ledger.obs) {
        const sl = (o.sigs || []).filter(live);
        if (!sl.length) continue;
        liveObs.push({ o, sl, at: Math.min(...sl.map(s => pos.get(s))) });
    }
    liveObs.sort((a, b) => a.at - b.at || a.o.id - b.o.id);

    // 2. fold
    for (const { o, sl, at } of liveObs) {
        if (o.how === 'update') {                       // status-update records don't describe an entity themselves
            for (const u of (o.u || [])) if ((u.sigs || []).length && u.sigs.every(live)) applyUpdate(u);
            continue;
        }
        const id = resolveId(o.e);
        let E = ents.get(id);
        if (!E) {
            E = {
                id, name: o.nm, type: o.ty || 'other', aliases: [], keys: [], user: ledger.ents[id] || {},
                _names: [], _types: [], _imp: [], _conf: [], _pos: new Set(), facts: [], staticRef: null, liveObs: 0, firstAt: at, lastAt: at,
            };
            ents.set(id, E);
        }
        E.liveObs++;
        E.lastAt = Math.max(E.lastAt, at);
        E._names.push(o.nm);
        E._types.push(o.ty || 'other');
        E._imp.push(o.imp); E._conf.push(o.conf);
        for (const s of sl) E._pos.add(pos.get(s));
        E.aliases.push(...(o.al || []));
        E.keys.push(...(o.ks || []));
        if (o.st && !E.staticRef) E.staticRef = o.st;

        for (const f of (o.f || [])) {
            if (!(f.sigs || []).length || !f.sigs.every(live)) continue;       // fact's own sources must all be live
            addFact(E, f, at, o.id);
        }
    }

    function addFact(E, f, at, obsId) {
        const id = factId(E.id, f.s);
        const base = {
            id, text: f.s, status: f.st, slot: f.slot || '', val: norm(f.s), by: f.by || 'story', ev: f.ev || '',
            relKind: f.relKind || null, other: f.other || null, ch: !!f.ch, srcs: [...(f.sigs || [])], at, obsId,
            state: 'active', disputed: false, supBy: null,
        };
        // exact/near duplicate of an existing fact with the same status class -> merge provenance
        for (const g of E.facts) {
            if (g.state === 'false' || g.state === 'abandoned') continue;
            if (g.status === base.status && (g.id === id || similarText(g.text, base.text))) {
                g.srcs = uniq([...g.srcs, ...base.srcs]);
                if (base.text.length > g.text.length && g.state === 'active') g.text = base.text; // keep the more complete wording
                return;
            }
        }
        // a confirmed fact that restates a rumor/claim settles it
        if (base.status === 'confirmed') {
            for (const g of E.facts) {
                if (g.state === 'active' && ['rumor', 'claim', 'unresolved'].includes(g.status) && similarText(g.text, base.text, 0.6)) {
                    g.state = 'superseded'; g.supBy = id;
                }
            }
        }
        // single-valued attribute conflicts
        if (base.status === 'confirmed' && base.slot) {
            const prev = E.facts.find(g => g.state === 'active' && g.status === 'confirmed' && g.slot === base.slot && g.val !== base.val);
            if (prev) {
                const ta = contentTokens(prev.text), tb = contentTokens(base.text);
                const refinement = Math.min(ta.length, tb.length) >= 1 && containment(ta, tb) >= 0.99 && prev.slot !== 'status' && !base.slot.startsWith('rel:');
                if (refinement) {                                   // "herbalist" -> "herbalist and shop owner": same fact, more detail
                    if (tb.length >= ta.length) { prev.text = base.text; prev.val = base.val; }
                    prev.srcs = uniq([...prev.srcs, ...base.srcs]);
                    return;
                }
                const key = hash(prev.id + '|' + id);
                let decision = ledger.decisions[key];
                if (!decision) {
                    if (base.ch) decision = 'new';                   // the story itself shows the change
                    else if (S.playerAuthoritative && base.by === 'player' && prev.by !== 'player') decision = 'new';
                    else if (S.playerAuthoritative && prev.by === 'player' && base.by !== 'player') decision = 'old';
                    else decision = { latest: 'new', both: 'both', ask: 'ask' }[S.conflictPolicy] || 'both';
                }
                if (decision === 'new') { prev.state = 'superseded'; prev.supBy = id; }
                else if (decision === 'old') { base.state = 'rejected'; }
                else if (decision === 'both') { prev.disputed = true; base.disputed = true; }
                else if (decision === 'ask') {
                    base.state = 'conflict';
                    conflicts.push({ key, entity: E.id, entityName: E.name, slot: base.slot, oldId: prev.id, newId: id, oldText: prev.text, newText: base.text });
                }
            }
        }
        E.facts.push(base);
        factIndex.set(id, { E, f: base });
    }

    function applyUpdate(u) {
        const hit = factIndex.get(u.ref);
        if (!hit) return;
        const f = hit.f;
        if (u.to === 'confirmed' && ['rumor', 'claim', 'unresolved'].includes(f.status)) { f.status = 'confirmed'; f.state = 'active'; }
        else if (u.to === 'false') f.state = 'false';
        else if (u.to === 'done' && f.status === 'plan') f.state = 'done';
        else if (u.to === 'abandoned' && f.status === 'plan') f.state = 'abandoned';
    }

    // 3. finalise each entity
    const staticTok = new Map();
    for (const E of ents.values()) {
        const nameCount = countBy(E._names);
        E.name = E.user.name || topKey(nameCount, k => k === E._names[0]) || E.name;
        const types = countBy(E._types.filter(t => t && t !== 'other'));
        E.type = E.user.type || topKey(types) || 'other';
        E.aliases = uniq([...E._names, ...E.aliases]).filter(a => norm(a) !== norm(E.name)).slice(0, 10);
        E.keys = uniq(E.keys);
        const pset = [...E._pos].sort((a, b) => a - b);
        E.appear = pset.length;
        E.episodes = episodesOf(pset, S.episodeGap ?? 6);
        E.span = pset.length ? pset[pset.length - 1] - pset[0] : 0;
        E.impMax = Math.max(...E._imp); E.impAvg = E._imp.reduce((a, b) => a + b, 0) / E._imp.length;
        E.confMax = Math.max(...E._conf); E.confAvg = E._conf.reduce((a, b) => a + b, 0) / E._conf.length;
        delete E._names; delete E._types; delete E._imp; delete E._conf; delete E._pos;

        // static lore: only facts the static card doesn't already state survive ("delta")
        if (E.staticRef) {
            const si = staticInfo.get(E.staticRef);
            if (si) {
                E.staticName = si.name;
                E.keys = uniq([...(si.keys || []), ...E.keys]);
                if (!staticTok.has(E.staticRef)) staticTok.set(E.staticRef, contentTokens(si.content || ''));
                const st = staticTok.get(E.staticRef);
                for (const f of E.facts) {
                    if (f.state === 'active' && st.length && containment(contentTokens(f.text), st) >= 0.85 && contentTokens(f.text).length >= 2) f.state = 'in-static';
                }
            }
        }
        const renderable = E.facts.filter(f => ['active', 'conflict'].includes(f.state) || f.disputed);
        E.hasContent = renderable.some(f => f.state === 'active');

        const c = classify(E, S);
        E.state = c.state; E.reason = c.reason;
    }
    return { ents, factIndex, conflicts, pos };
}

export function classify(E, S) {
    const u = E.user || {};
    if (u.status === 'reject') return { state: 'rejected', reason: 'rejected by user' };
    if (E.staticRef && S.staticMatch === 'ignore') return { state: 'rejected', reason: 'exists in static lore (ignored by setting)' };
    if (u.status === 'promote') return { state: E.hasContent ? 'promoted' : 'candidate', reason: E.hasContent ? 'promoted by user' : 'promoted by user but no facts yet' };
    const rule = (S.typeRules || {})[E.type] || (S.typeRules || {}).other || { on: true, minAppearances: 2, minImportance: 3 };
    if (!rule.on) return { state: 'excluded', reason: `type "${E.type}" is excluded` };
    if (E.confMax < S.minConfidence) return { state: 'candidate', reason: `confidence ${E.confMax.toFixed(2)} < ${S.minConfidence}` };
    const minImp = Math.max(S.minImportance ?? 0, rule.minImportance ?? 0);
    const instant = E.impMax >= (S.instantImportance ?? 8);
    const recurring = E.episodes >= (rule.minAppearances ?? 2) || E.appear >= (S.longEpisodeMsgs ?? 10);
    if (E.impMax < minImp && !instant) return { state: 'candidate', reason: `importance ${E.impMax.toFixed(1)} < ${minImp}` };
    if (!instant && !recurring) {
        return { state: 'candidate', reason: `seen in ${E.episodes} scene(s); needs ${rule.minAppearances ?? 2} or importance ≥ ${S.instantImportance ?? 8}` };
    }
    if (!E.hasContent) return { state: 'candidate', reason: E.staticRef ? 'nothing new beyond static lore' : 'no established facts yet' };
    return { state: 'promoted', reason: instant ? `importance ${E.impMax.toFixed(1)} ≥ ${S.instantImportance ?? 8}` : `${E.episodes} scenes, importance ${E.impMax.toFixed(1)}` };
}
