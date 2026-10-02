// Pure helpers (no SillyTavern imports) so the core can be unit-tested in Node.

/** 53-bit string hash (cyrb53). Not cryptographic; used for message signatures. */
export function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const hash = (s) => cyrb53(String(s)).toString(36);

/** Lowercase, strip accents/punctuation, collapse whitespace. */
export function norm(s) {
    return String(s ?? '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[’'`]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'from', 'with', 'for', 'by',
    'his', 'her', 'their', 'its', 'is', 'was', 'are', 'were', 'be', 'that', 'this', 'as', 'or', 'it', 'he', 'she', 'they']);

export const tokens = (s) => norm(s).split(' ').filter(Boolean);
export const contentTokens = (s) => tokens(s).filter(t => !STOP.has(t));

export function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}
/** share of the smaller set contained in the larger one */
export function containment(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    const [s, l] = A.size <= B.size ? [A, B] : [B, A];
    let inter = 0;
    for (const x of s) if (l.has(x)) inter++;
    return inter / s.size;
}
function bigrams(s) {
    const t = ` ${s} `, out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
        const g = t.slice(i, i + 2);
        out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
}
/** Sørensen–Dice similarity on character bigrams (0..1). */
export function dice(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0, sa = 0, sb = 0;
    for (const [g, c] of A) { sa += c; if (B.has(g)) inter += Math.min(c, B.get(g)); }
    for (const c of B.values()) sb += c;
    return (2 * inter) / (sa + sb);
}
export const similarText = (a, b, th = 0.75) => {
    const ta = contentTokens(a), tb = contentTokens(b);
    return jaccard(ta, tb) >= th || (Math.min(ta.length, tb.length) >= 3 && containment(ta, tb) >= 0.95);
};

export const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 48) || 'x';
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));
export const uniq = (arr) => [...new Set(arr)];

/**
 * Strip anything that could act on SillyTavern when this text is later injected into a prompt:
 * HTML tags, control characters, and {{macro}} syntax.
 */
export function sanitizeText(s, max = 200) {
    let t = String(s ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
        .replace(/\s+/g, ' ')
        .trim();
    if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '');
    return t;
}

const GENERIC_KEYS = new Set(['the', 'a', 'an', 'man', 'woman', 'girl', 'boy', 'guard', 'guards', 'merchant', 'waiter', 'bartender',
    'he', 'she', 'it', 'they', 'him', 'her', 'them', 'i', 'you', 'we', 'me', 'us', 'city', 'town', 'village', 'place', 'person',
    'people', 'lady', 'lord', 'sir', 'master', 'shop', 'inn', 'tavern', 'road', 'forest', 'room', 'house', 'door', 'night', 'day',
    'old', 'young', 'stranger', 'traveler', 'traveller', 'customer', 'child', 'kid', 'soldier', 'soldiers', 'noble', 'nobles']);
export const isGenericWord = (w) => GENERIC_KEYS.has(norm(w));

/** A key must be a plain, specific, non-regex, non-macro string. Returns null when unusable. */
export function sanitizeKey(k) {
    let t = String(k ?? '').replace(/\{\{.*?\}\}/g, '').replace(/[\r\n]+/g, ' ').trim();
    t = t.replace(/^[\/"'“”‘’\s]+|[\/"'“”‘’\s]+$/g, '');   // a leading/trailing slash would make ST treat it as a regex
    if (t.length < 2 || t.length > 40) return null;
    if (isGenericWord(t)) return null;
    if (/^[\d\W]+$/.test(t)) return null;
    return t;
}

export function stableStringify(o) {
    return JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
        ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
}
