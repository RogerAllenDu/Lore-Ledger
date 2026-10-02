export const TYPES = ['character', 'location', 'faction', 'organization', 'family', 'creature', 'item',
    'ability', 'magic', 'event', 'quest', 'mystery', 'business', 'other'];

export const FACT_STATUS = ['confirmed', 'rumor', 'claim', 'plan', 'unresolved'];

/** Single-valued attributes: two different confirmed values = a conflict (unless the story shows a change). */
export const SLOTS = ['occupation', 'residence', 'species', 'age', 'gender', 'title', 'allegiance', 'status',
    'leader', 'location', 'owner', 'purpose', 'appearance'];

export const REL_KINDS = ['knows', 'acquaintance', 'ally', 'friend', 'employer', 'employee', 'rival', 'enemy',
    'family', 'mentor', 'student', 'romantic_interest', 'partner', 'other'];
export const ROMANTIC = new Set(['romantic_interest', 'partner']);

export const DEFAULT_TYPE_RULES = {
    character:    { on: true,  minAppearances: 2, minImportance: 3 },
    location:     { on: true,  minAppearances: 2, minImportance: 3 },
    faction:      { on: true,  minAppearances: 2, minImportance: 3 },
    organization: { on: true,  minAppearances: 2, minImportance: 3 },
    family:       { on: true,  minAppearances: 2, minImportance: 3 },
    creature:     { on: true,  minAppearances: 2, minImportance: 4 },
    item:         { on: true,  minAppearances: 2, minImportance: 4 },
    ability:      { on: true,  minAppearances: 1, minImportance: 5 },
    magic:        { on: true,  minAppearances: 1, minImportance: 5 },
    event:        { on: true,  minAppearances: 1, minImportance: 6 },
    quest:        { on: true,  minAppearances: 1, minImportance: 5 },
    mystery:      { on: true,  minAppearances: 1, minImportance: 6 },
    business:     { on: true,  minAppearances: 2, minImportance: 3 },
    other:        { on: false, minAppearances: 3, minImportance: 5 },
};

export const DEFAULT_SETTINGS = {
    enabled: false,
    // --- when to extract ---
    extractEvery: 6,        // run once this many settled, unscanned messages have accumulated
    settleLag: 2,           // never extract the newest N messages (the user may still swipe/regenerate)
    windowMax: 12,          // max new messages per extraction call
    contextMsgs: 3,         // already-scanned messages shown for continuity
    maxCharsPerMsg: 5000,
    // --- when a candidate becomes lore ---
    minConfidence: 0.6,
    minImportance: 3,       // global floor (type rules can raise it)
    instantImportance: 8,   // at/above this a single appearance is enough
    minSpan: 2,             // appearances must be at least this many messages apart (a "return")
    typeRules: structuredClone(DEFAULT_TYPE_RULES),
    protagonist: ['Dragon'],
    // --- how changes are applied ---
    applyMode: 'auto',      // 'auto' | 'review'
    conflictPolicy: 'both', // 'both' | 'latest' | 'ask'
    playerAuthoritative: true,
    staticMatch: 'delta',   // 'delta' (only new facts) | 'ignore'
    onManualEdit: 'lock',   // 'lock' | 'overwrite'
    includeUncertain: true,
    evidenceStrictness: 'strict', // 'strict' drops facts whose quote isn't in the cited messages; 'lenient' downgrades them
    // --- static (protected) lore ---
    staticBooks: [],
    autoDetectStatic: true,
    // --- World Info entry defaults for new dynamic entries ---
    position: 0,            // 0 before char defs, 1 after, 2 AN top, 3 AN bottom, 4 @depth
    depth: 4,
    order: 100,
    role: 0,
    maxChars: 900,
    maxKeys: 8,
    // --- model call ---
    connection: 'current',  // 'current' (generateRaw) | 'profile' (Connection Manager profile)
    profileId: '',
    useSchema: true,
    maxTokens: 4000,
    extraRules: '',
};

export function mergeSettings(saved) {
    const s = structuredClone(DEFAULT_SETTINGS);
    if (saved && typeof saved === 'object') {
        for (const k of Object.keys(saved)) {
            if (k === 'typeRules') {
                for (const t of Object.keys(saved.typeRules || {})) s.typeRules[t] = { ...(s.typeRules[t] || {}), ...saved.typeRules[t] };
            } else {
                s[k] = saved[k];
            }
        }
    }
    return s;
}
