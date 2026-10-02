// Extraction schema + validation. Model output is UNTRUSTED data: it is parsed, whitelisted,
// length-capped and sanitised here before anything else touches it.

import { TYPES, FACT_STATUS, SLOTS, REL_KINDS, ROMANTIC } from './config.js';
import { sanitizeText, sanitizeKey, norm, clamp, contentTokens, tokens } from './util.js';

const strArr = { type: 'array', items: { type: 'string' } };
const intArr = { type: 'array', items: { type: 'integer' } };

/**
 * JSON schema passed to generateRaw({ jsonSchema }). Deliberately plain (no oneOf/$ref/
 * additionalProperties) so SillyTavern can translate it for Gemini's responseSchema as well
 * as OpenAI-style strict schemas.
 */
export const EXTRACTION_JSON_SCHEMA = {
    name: 'LoreExtraction',
    description: 'Persistent lore observed in the new story messages',
    strict: true,
    value: {
        type: 'object',
        properties: {
            entities: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        matches_id: { type: 'string' },
                        type: { type: 'string', enum: TYPES },
                        action: { type: 'string', enum: ['create', 'update', 'mention', 'ignore'] },
                        aliases: strArr,
                        keys: strArr,
                        importance: { type: 'number' },
                        confidence: { type: 'number' },
                        reason: { type: 'string' },
                        messages: intArr,
                        facts: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string' },
                                    status: { type: 'string', enum: FACT_STATUS },
                                    slot: { type: 'string' },
                                    changes_previous: { type: 'boolean' },
                                    evidence: { type: 'string' },
                                    messages: intArr,
                                },
                                required: ['text', 'status', 'evidence', 'messages'],
                            },
                        },
                        relationships: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    other: { type: 'string' },
                                    kind: { type: 'string', enum: REL_KINDS },
                                    text: { type: 'string' },
                                    explicit: { type: 'boolean' },
                                    changes_previous: { type: 'boolean' },
                                    evidence: { type: 'string' },
                                    messages: intArr,
                                },
                                required: ['other', 'kind', 'evidence', 'messages'],
                            },
                        },
                    },
                    required: ['name', 'type', 'action', 'importance', 'confidence', 'messages'],
                },
            },
            fact_updates: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        fact_id: { type: 'string' },
                        new_status: { type: 'string', enum: ['confirmed', 'false', 'done', 'abandoned'] },
                        evidence: { type: 'string' },
                        messages: intArr,
                    },
                    required: ['fact_id', 'new_status', 'evidence', 'messages'],
                },
            },
        },
        required: ['entities'],
    },
};

/** Tolerant JSON extraction: handles fences, prose around the object, trailing commas. */
export function parseModelJson(text) {
    if (text && typeof text === 'object') return text;
    let t = String(text ?? '').trim();
    if (!t) return null;
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const attempt = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
    let r = attempt(t);
    if (r !== undefined) return r;
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
        const slice = t.slice(a, b + 1);
        r = attempt(slice);
        if (r !== undefined) return r;
        r = attempt(slice.replace(/,\s*([}\]])/g, '$1'));
        if (r !== undefined) return r;
    }
    const a2 = t.indexOf('['), b2 = t.lastIndexOf(']');
    if (a2 !== -1 && b2 > a2) {
        r = attempt(t.slice(a2, b2 + 1));
        if (r !== undefined) return { entities: r };
    }
    return null;
}

// --- guardrail heuristics (second line of defence behind the prompt) ----------------------

const HEDGE = /\b(seems?|seemed|appears? to|appeared to|might|maybe|perhaps|possibly|probably|presumably|allegedly|supposedly|apparently|rumou?red|rumou?rs?|said to be|thought to be|believed to be|speculat\w*|suspects?|suspected|could be|may be|may have|might have|unclear|uncertain)\b/i;
const FUTURE = /\b(plans? to|planning to|intends? to|intending to|is going to|are going to|going to|will\b|shall\b|promises? to|promised to|vows? to|vowed to|swears? to|aims? to|hopes? to|expects? to|wants? to|wishes? to|scheduled to|preparing to|about to|prepares to|threatens? to)\b/i;
const CLAIM = /\b(claims?|claimed|says? (?:he|she|they|that|i)|said (?:he|she|they|that)|insists?|insisted|pretends?|pretended|lied|lying about|boasts?|boasted|alleges?|alleged|purports?|professes?)\b/i;
const MENTAL = /\b(feels?|felt|feeling|thinks?|thought|thinking|wants?|wanted|decides?|decided|loves?|loved|likes?|liked|hates?|hated|trusts?|trusted|fears?|feared|intends?|hopes?|hoped|believes?|believed|desires?|craves?|enjoys?|enjoyed|resents?|regrets?|consents?|agrees?|agreed|chooses?|chose|swears?|promises?|attracted|in love|falls? for|fell for)\b/i;

export function buildProtagonistRegex(names) {
    const list = [...new Set((names || []).map(n => String(n).trim()).filter(Boolean)), 'protagonist', 'the player'];
    const esc = list.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\b(?:${esc.join('|')})\\b`, 'i');
}

export function isProtagonistName(name, names) {
    const n = norm(name);
    return (names || []).some(p => norm(p) === n) || n === 'user' || n === 'you' || n === 'player';
}

/** Does this fact assert something about the protagonist's mind/feelings/choices? */
export function violatesAgency(text, protRe) {
    if (!protRe.test(text)) return false;
    return MENTAL.test(text);
}

/**
 * Re-classify a fact's status when its wording says something the model's label doesn't.
 * "confirmed" is the dangerous label, so it is the only one we ever demote.
 */
export function guardStatus(text, status) {
    if (status !== 'confirmed') return status;
    if (FUTURE.test(text)) return 'plan';
    if (CLAIM.test(text)) return 'claim';
    if (HEDGE.test(text)) return 'unresolved';
    return status;
}

/** Is the quoted evidence actually present in the cited messages? (tolerates small edits) */
export function evidenceHolds(evidence, texts) {
    const ev = norm(evidence);
    if (ev.length < 6) return false;
    const hay = norm(texts.join(' '));
    if (hay.includes(ev)) return true;
    const et = contentTokens(evidence);
    if (et.length < 3) return false;
    const ht = new Set(tokens(texts.join(' ')));
    let hit = 0;
    for (const t of et) if (ht.has(t)) hit++;
    return hit / et.length >= 0.8;
}

/**
 * Validate and sanitise raw parsed model output.
 * @param raw        parsed JSON
 * @param win        [{n, sig, is_user, text, isContext}]  (n is 1-based, as shown to the model)
 * @param opts       { protagonist:[], excludedTypes:Set, evidenceStrictness, knownFactIds:Set }
 * @returns { entities:[...], updates:[...], dropped:[{what, why}] }
 */
export function validateExtraction(raw, win, opts = {}) {
    const dropped = [];
    const out = { entities: [], updates: [], dropped };
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entities)) {
        dropped.push({ what: 'response', why: 'not an object with an entities array' });
        return out;
    }
    const byN = new Map(win.map(w => [w.n, w]));
    const protRe = buildProtagonistRegex(opts.protagonist);
    const strict = (opts.evidenceStrictness || 'strict') === 'strict';
    const cite = (arr) => {
        const ws = [...new Set((Array.isArray(arr) ? arr : []).map(x => Math.trunc(+x)).filter(n => byN.has(n)))].map(n => byN.get(n));
        return ws;
    };

    for (const e of raw.entities.slice(0, 40)) {
        if (!e || typeof e !== 'object') continue;
        const name = sanitizeText(e.name, 60);
        if (!name) { dropped.push({ what: 'entity', why: 'no name' }); continue; }
        const action = ['create', 'update', 'mention', 'ignore'].includes(e.action) ? e.action : 'mention';
        if (action === 'ignore') continue;
        if (isProtagonistName(name, opts.protagonist)) { dropped.push({ what: name, why: 'protagonist is never given a card' }); continue; }
        const type = TYPES.includes(e.type) ? e.type : 'other';
        if (opts.excludedTypes && opts.excludedTypes.has(type)) { dropped.push({ what: name, why: `type ${type} excluded` }); continue; }
        const msgs = cite(e.messages);
        if (!msgs.length) { dropped.push({ what: name, why: 'no cited messages (no provenance)' }); continue; }

        const aliases = [...new Set((Array.isArray(e.aliases) ? e.aliases : []).map(a => sanitizeText(a, 60)).filter(a => a && norm(a) !== norm(name) && !isProtagonistName(a, opts.protagonist)))].slice(0, 8);
        const keys = [...new Set((Array.isArray(e.keys) ? e.keys : []).map(sanitizeKey).filter(Boolean))].slice(0, 10);

        const facts = [];
        for (const f of (Array.isArray(e.facts) ? e.facts : []).slice(0, 14)) {
            if (!f || typeof f !== 'object') continue;
            const text = sanitizeText(f.text, 180);
            if (text.length < 3) continue;
            const fm = cite(f.messages).length ? cite(f.messages) : msgs;
            let status = FACT_STATUS.includes(f.status) ? f.status : 'unresolved';
            if (violatesAgency(text, protRe)) { dropped.push({ what: text, why: 'asserts protagonist thoughts/feelings/choices' }); continue; }
            const ok = evidenceHolds(f.evidence, fm.map(m => m.text));
            if (!ok) {
                if (strict) { dropped.push({ what: text, why: 'evidence quote not found in cited messages' }); continue; }
                status = status === 'confirmed' ? 'unresolved' : status;
            }
            status = guardStatus(text, status);
            const slotRaw = norm(f.slot).replace(/\s+/g, '_');
            const slot = SLOTS.includes(slotRaw) ? slotRaw : '';
            facts.push({
                s: text, st: status, slot,
                ch: !!f.changes_previous,
                ev: sanitizeText(f.evidence, 140),
                by: fm.every(m => m.is_user) ? 'player' : 'story',
                sigs: [...new Set(fm.map(m => m.sig))],
            });
        }

        const rels = [];
        for (const r of (Array.isArray(e.relationships) ? e.relationships : []).slice(0, 8)) {
            if (!r || typeof r !== 'object') continue;
            const other = sanitizeText(r.other, 60);
            const kind = REL_KINDS.includes(r.kind) ? r.kind : 'other';
            if (!other || norm(other) === norm(name)) continue;
            const rm = cite(r.messages).length ? cite(r.messages) : msgs;
            const text = sanitizeText(r.text || kind.replace('_', ' '), 100);
            if (violatesAgency(`${other} ${text}`, protRe) && !ROMANTIC.has(kind)) { dropped.push({ what: `${name}↔${other}`, why: 'protagonist feelings/choices' }); continue; }
            if (ROMANTIC.has(kind) && !r.explicit) { dropped.push({ what: `${name}↔${other}:${kind}`, why: 'romantic relationship not explicitly established' }); continue; }
            if (!evidenceHolds(r.evidence, rm.map(m => m.text))) { dropped.push({ what: `${name}↔${other}`, why: 'relationship evidence not found' }); continue; }
            rels.push({
                s: text, st: 'confirmed', slot: `rel:${norm(other)}`, relKind: kind, other,
                ch: !!r.changes_previous, ev: sanitizeText(r.evidence, 140),
                by: rm.every(m => m.is_user) ? 'player' : 'story', sigs: [...new Set(rm.map(m => m.sig))],
            });
        }

        out.entities.push({
            name, matchesId: sanitizeText(e.matches_id, 80), type, action, aliases, keys,
            imp: clamp(e.importance, 0, 10), conf: clamp(e.confidence, 0, 1),
            why: sanitizeText(e.reason, 140),
            sigs: [...new Set(msgs.map(m => m.sig))],
            facts, rels,
        });
    }

    for (const u of (Array.isArray(raw.fact_updates) ? raw.fact_updates : []).slice(0, 30)) {
        if (!u || typeof u !== 'object') continue;
        const id = sanitizeText(u.fact_id, 24);
        if (!id || (opts.knownFactIds && !opts.knownFactIds.has(id))) { dropped.push({ what: `update ${id}`, why: 'unknown fact id' }); continue; }
        const to = ['confirmed', 'false', 'done', 'abandoned'].includes(u.new_status) ? u.new_status : null;
        const um = cite(u.messages);
        if (!to || !um.length) continue;
        if (!evidenceHolds(u.evidence, um.map(m => m.text))) { dropped.push({ what: `update ${id}`, why: 'evidence not found' }); continue; }
        out.updates.push({ ref: id, to, ev: sanitizeText(u.evidence, 140), sigs: [...new Set(um.map(m => m.sig))] });
    }
    return out;
}
