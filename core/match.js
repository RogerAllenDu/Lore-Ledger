// Entity resolution. Goal: "Elena", "Elena the herbalist" and "the fox girl Elena" -> one entity,
// without ever merging two different entities on a weak guess.

import { norm, tokens, dice, slug, isGenericWord } from './util.js';

const FAMILIES = {
    character: 'being', creature: 'being', family: 'group', faction: 'group', organization: 'group', business: 'place',
    location: 'place', item: 'thing', ability: 'power', magic: 'power', event: 'event', quest: 'event', mystery: 'event',
};
export const familyOf = (type) => FAMILIES[type] || 'other';
const compatible = (a, b) => a === 'other' || b === 'other' || familyOf(a) === familyOf(b);

const DESCRIPTOR = new Set(['the', 'a', 'an', 'of', 'and', 'lord', 'lady', 'sir', 'dame', 'master', 'miss', 'mr', 'mrs', 'ms',
    'young', 'old', 'little', 'big', 'great', 'fox', 'girl', 'boy', 'man', 'woman', 'elf', 'dwarf', 'beastfolk', 'human']);

const RELATIONAL = new Set(['brother', 'sister', 'mother', 'father', 'son', 'daughter', 'wife', 'husband', 'friend', 'servant',
    'ally', 'enemy', 'rival', 'mentor', 'student', 'apprentice', 'cousin', 'uncle', 'aunt', 'lover', 'partner', 'boss', 'employer']);

/** Name tokens minus articles/honorifics (kept for single-token names so "Lord" alone never matches). */
function coreTokens(name) {
    const t = tokens(name);
    const core = t.filter(x => !['the', 'a', 'an', 'of', 'and', 'lord', 'lady', 'sir', 'dame', 'master', 'miss', 'mr', 'mrs', 'ms'].includes(x));
    return core.length ? core : t;
}

export class Registry {
    constructor() {
        /** @type {Map<string, {id, type, src, names:Set<string>, display:string}>} */
        this.entries = new Map();
        this.exact = new Map();   // normalised name/alias/key -> Set(id)
    }

    add({ id, type = 'other', src = 'dyn', names = [], display = '' }) {
        let e = this.entries.get(id);
        if (!e) { e = { id, type, src, names: new Set(), display: display || names[0] || id }; this.entries.set(id, e); }
        for (const n of names) {
            const k = norm(n);
            if (!k) continue;
            e.names.add(k);
            if (!this.exact.has(k)) this.exact.set(k, new Set());
            this.exact.get(k).add(id);
        }
        return e;
    }

    get(id) { return this.entries.get(id); }

    /**
     * Find the entity a name (plus any aliases the model gave) refers to.
     * Returns { id, how } or null. Ambiguity returns null (a new entity is safer than a wrong merge).
     */
    find(name, aliases = [], type = 'other') {
        const queries = [name, ...aliases].map(norm).filter(Boolean);
        const okType = (e) => compatible(type, e.type);

        // 1. exact match on any known name/alias/key
        for (const q of queries) {
            const hit = this.exact.get(q);
            if (hit) {
                const ids = [...hit].filter(id => okType(this.entries.get(id)));
                const dyn = ids.filter(id => this.entries.get(id).src === 'dyn');
                const pick = dyn.length === 1 ? dyn : ids;
                if (pick.length === 1) return { id: pick[0], how: 'exact' };
                if (pick.length > 1) return null; // ambiguous
            }
        }

        // 2. token containment: "elena the herbalist" contains the known name "elena" (and "Elena" is part of "Elena Brightwood").
        //    Only people/groups may absorb epithets; places and things need their extra words to be mere descriptors,
        //    so "East Parada" is never merged into "Parada", nor "Elena's brother Rian" into "Elena".
        const found = new Map();
        for (const q of queries) {
            const qt = coreTokens(q);
            if (!qt.length) continue;
            if (qt.some(x => RELATIONAL.has(x))) continue;      // a relation phrase, not a name
            for (const e of this.entries.values()) {
                if (!okType(e)) continue;
                const isPerson = familyOf(e.type) === 'being' || familyOf(e.type) === 'group';
                for (const n of e.names) {
                    const nt = coreTokens(n);
                    if (!nt.length) continue;
                    const nSig = nt.filter(x => !DESCRIPTOR.has(x));
                    const qSig = qt.filter(x => !DESCRIPTOR.has(x));
                    if (!nSig.length || !qSig.length) continue;
                    if (nSig.length === 1 && isGenericWord(nSig[0])) continue;
                    if (qSig.length === 1 && isGenericWord(qSig[0])) continue;
                    const extrasInQ = qt.filter(x => !nt.includes(x));
                    const nInQ = nSig.every(x => qt.includes(x)) && (isPerson || extrasInQ.every(x => DESCRIPTOR.has(x)));
                    const qInN = isPerson && qSig.every(x => nt.includes(x));
                    if (nInQ || qInN) found.set(e.id, (found.get(e.id) || 0) + 1);
                }
            }
        }
        if (found.size === 1) return { id: [...found.keys()][0], how: 'tokens' };
        if (found.size > 1) {
            // prefer dynamic entities; if still ambiguous, refuse
            const dyn = [...found.keys()].filter(id => this.entries.get(id).src === 'dyn');
            if (dyn.length === 1) return { id: dyn[0], how: 'tokens-dyn' };
            return null;
        }

        // 3. fuzzy spelling variant ("Elenna" ~ "Elena"), same family, single best hit only
        let best = null, second = 0;
        for (const q of queries) {
            if (q.length < 5) continue;
            for (const e of this.entries.values()) {
                if (!okType(e)) continue;
                for (const n of e.names) {
                    const d = dice(q, n);
                    if (d >= 0.88 && (!best || d > best.d)) { if (best) second = best.d; best = { id: e.id, d }; }
                    else if (d > second) second = d;
                }
            }
        }
        if (best && best.d - second > 0.04) return { id: best.id, how: 'fuzzy' };
        return null;
    }

    /** Fresh id for a new entity, avoiding collisions with other families. */
    newId(name, type) {
        let id = slug(name);
        const taken = this.entries.get(id);
        if (!taken) return id;
        if (taken.type === type || compatible(type, taken.type)) return id;
        return `${id}-${slug(type)}`;
    }
}

/** Build a registry from derived dynamic entities + a list of static entries. */
export function buildRegistry(derivedEnts, staticEntries = []) {
    const reg = new Registry();
    for (const e of derivedEnts) {
        const ent = reg.add({ id: e.id, type: e.type, src: 'dyn', names: [e.name, ...e.aliases, ...e.keys], display: e.name });
        if (e.staticRef) ent.staticOf = e.staticRef;
    }
    for (const s of staticEntries) {
        reg.add({ id: s.id, type: s.type || 'other', src: 'static', names: [s.name, ...(s.keys || [])], display: s.name });
    }
    return reg;
}
