import { validateExtraction, parseModelJson } from './schema.js';
import { norm, uniq } from './util.js';

/**
 * Turn raw model output into observations on the ledger.
 *
 * @param ledger
 * @param win       [{n, sig, is_user, text, isContext}]
 * @param raw       model output (string or parsed object)
 * @param ctx       { registry, protagonist:[], excludedTypes:Set, evidenceStrictness, knownFactIds:Set }
 * @returns { added, droppedCount, dropped, entities:[ids] }
 */
export function ingestExtraction(ledger, win, raw, ctx) {
    const parsed = typeof raw === 'string' ? parseModelJson(raw) : raw;
    const v = validateExtraction(parsed, win, ctx);
    const reg = ctx.registry;
    const touched = [];
    let added = 0;

    for (const e of v.entities) {
        // resolve to an existing entity (dynamic or static) or mint a new one
        let id = null, staticId = null, canonical = e.name, how = 'new';
        const hinted = e.matchesId && reg.get(e.matchesId);
        const hit = hinted ? { id: e.matchesId, how: 'model' } : reg.find(e.name, e.aliases, e.type);
        if (hit) {
            const ent = reg.get(hit.id);
            how = hit.how;
            if (ent.src === 'static') {
                staticId = ent.id;
                // a dynamic "delta" entity that rides on the static card
                id = reg.newId(`d ${ent.display}`, e.type);
                canonical = ent.display;
            } else {
                id = ent.id;
                canonical = ent.display;
            }
        } else {
            id = reg.newId(e.name, e.type);
        }
        // an existing dynamic delta for this static entry? reuse it
        if (staticId) {
            for (const x of reg.entries.values()) {
                if (x.src === 'dyn' && x.staticOf === staticId) { id = x.id; break; }
            }
        }
        const al = uniq([e.name, ...e.aliases].filter(a => norm(a) !== norm(canonical))).slice(0, 8);
        const fs = [...e.facts, ...e.rels.map(r => ({ ...r, s: `${r.other}: ${r.s}` }))];

        ledger.obs.push({
            id: ledger.nextObs++, e: id, nm: canonical, ty: e.type, al, ks: e.keys,
            sigs: e.sigs, imp: e.imp, conf: e.conf, why: e.why, st: staticId, how,
            f: fs, u: [], t: Date.now(),
        });
        const ent = reg.add({ id, type: e.type, src: 'dyn', names: [canonical, ...al, ...e.keys], display: canonical });
        if (staticId) ent.staticOf = staticId;
        touched.push(id);
        added++;
    }

    if (v.updates.length) {
        // status updates ride on a pseudo-observation attached to the newest cited messages
        const sigs = uniq(v.updates.flatMap(u => u.sigs));
        ledger.obs.push({
            id: ledger.nextObs++, e: '_updates', nm: '_updates', ty: 'other', al: [], ks: [], sigs, imp: 0, conf: 1,
            why: 'fact status updates', st: null, how: 'update', f: [], u: v.updates, t: Date.now(),
        });
    }

    // every new (non-context) message has now been read, whether or not it produced lore
    for (const w of win) if (!w.isContext) ledger.scanned[w.sig] = 1;
    ledger.ver++;
    return { added, dropped: v.dropped, droppedCount: v.dropped.length, entities: uniq(touched), updates: v.updates.length };
}
