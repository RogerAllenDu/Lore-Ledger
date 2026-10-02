// Entity -> compact reference text for a World Info entry. Token efficiency matters:
// terse clauses, no prose, uncertain material labelled and kept after the confirmed facts.

import { sanitizeKey, norm, uniq, hash } from './util.js';

export const TAG = 'DL:';   // managed entries carry this prefix in their comment (title) field

export function entryComment(E) {
    return `${TAG}${E.id} | ${E.name} [${E.type}]`;
}
export function parseManagedId(comment) {
    const m = /^DL:([^\s|]+)/.exec(String(comment || ''));
    return m ? m[1] : null;
}

const end = (s) => s.replace(/[.;,\s]+$/, '');

export function renderKeys(E, S) {
    const raw = [E.name, ...E.aliases, ...E.keys];
    const out = [];
    const seen = new Set();
    for (const r of raw) {
        const k = sanitizeKey(r);
        if (!k) continue;
        const n = norm(k);
        if (seen.has(n)) continue;
        seen.add(n); out.push(k);
        if (out.length >= (S.maxKeys || 8)) break;
    }
    return out;
}

export function renderContent(E, S) {
    const facts = E.facts.filter(f => f.state === 'active');
    const confirmed = facts.filter(f => f.status === 'confirmed');
    const slotOrder = ['species', 'age', 'gender', 'occupation', 'title', 'residence', 'location', 'allegiance', 'leader', 'owner', 'status', 'purpose', 'appearance'];
    const rank = (f) => { const i = slotOrder.indexOf(f.slot); return f.relKind ? 100 : (i === -1 ? 50 : i); };
    const plain = confirmed.filter(f => !f.relKind).sort((a, b) => rank(a) - rank(b) || a.at - b.at);
    const rels = confirmed.filter(f => f.relKind);

    const lines = [];
    const head = `${E.name} (${E.type})`;
    const body = [];
    for (const f of plain) body.push(f.disputed ? `${end(f.text)} [disputed]` : end(f.text));
    if (rels.length) body.push(`Relations: ${rels.map(r => end(r.text)).join('; ')}`);
    lines.push(body.length ? `${head}: ${body.join('. ')}.` : `${head}.`);

    if (S.includeUncertain !== false) {
        const unc = [];
        const by = (st) => facts.filter(f => f.status === st);
        if (by('rumor').length) unc.push(`Rumors (unverified): ${by('rumor').map(f => end(f.text)).join('; ')}`);
        if (by('claim').length) unc.push(`Claims (may be false): ${by('claim').map(f => end(f.text)).join('; ')}`);
        if (by('plan').length) unc.push(`Plans (not yet done): ${by('plan').map(f => end(f.text)).join('; ')}`);
        if (by('unresolved').length) unc.push(`Unresolved: ${by('unresolved').map(f => end(f.text)).join('; ')}`);
        if (unc.length) lines.push(unc.join('. ') + '.');
    }

    // confirmed facts are the priority; uncertain lines are added only if they still fit the budget
    const max = S.maxChars || 900;
    let text = lines[0];
    if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, '') + '…';
    for (const extra of lines.slice(1)) if ((text + '\n' + extra).length <= max) text += '\n' + extra;
    return text;
}

export function render(E, S) {
    const content = renderContent(E, S);
    const keys = renderKeys(E, S);
    return { content, keys, comment: entryComment(E), ch: hash(content), kh: hash(keys.join('|')) };
}
