# Lore Ledger — branch-aware dynamic story lore for SillyTavern

Automatically maintains a **separate, compact lorebook** of the persistent characters, places, factions,
items, events and relationships that emerge in a long story, without touching your static lorebooks and
without recording guesses, lies, plans or the protagonist's feelings as fact.

## 1. Research findings (what already exists)

Checked June–Oct 2026 via web search and the current upstream docs / `st-context.js` / DeepWiki.

| Project | What it does | Why it is not enough here |
|---|---|---|
| **DynamicLore** (AugieIsHere) | LLM-generated lore suggestions with review | Self-described experimental; no candidate thresholds, provenance or swipe/branch handling |
| **Summaryception + Lorebook** (fork) | Extracts canonical facts into a lorebook with a review queue | Tied to its summarizer; write-once, not rebuilt when messages change |
| **Memory Books / STMemoryBooks** (aikohanasaki) | Scene summaries -> memory entries | Event memories, not an entity-state database. **Complements this extension** (use both) |
| **LoreManager** (Monblant, gitgud) | Template/regex-driven updates to the chat lorebook; keeps snapshots in messages | No LLM candidate/promotion logic, no fact-status integrity. Its idea of storing state with the messages is the same insight used here |
| **WorldInfo Recommender** (bmen25124) | Manual "suggest entries" button | Manual; no automation or provenance |
| **TunnelVision** (Coneja-Chibi / mozophe) | Agentic tool-calling retrieval/updates of lorebook entries | The main model edits cards directly (no uncertainty classes, no rollback, no branch awareness) |
| **DeepLore** (pixelnull) | Obsidian-vault-based lore | Different storage model, not ST World Info |

None provides: candidate -> promotion thresholds, per-message provenance, swipe/edit/branch-consistent
derived lore, fact-status integrity (rumor / claim / plan / confirmed), conflict handling, protection and
rollback together. **Recommendation: build this extension; keep Memory Books alongside it for scene summaries.**

## 2. Architecture (and why)

```
chat messages ──extract (every N msgs, off the story path)──▶ observations   (ledger, in chat metadata)
                                                               │ each tagged with SIGNATURES of the
                                                               │ messages that established it
active chat ──signatures present now──▶ derive() ──▶ entities + facts + promotion state
                                                               │
                                              plan/apply ──▶ dynamic World Info book (a CACHE)
```

* **Source of truth = the ledger**, stored in `chat_metadata` (saved with, and copied into, each chat file).
* A message signature = hash(role + text). Swipe, edit, delete, rewind or branch changes which signatures
  exist in the active chat; observations whose sources are gone stop contributing automatically (and come
  back if the same text returns, e.g. swiping back). No event-by-event bookkeeping, so it cannot drift.
* **Dynamic lore is a derived projection** written to its own lorebook `DynLore_<chat>_<id>`,
  bound as the **Chat Lorebook** (ST supports several sources at once: chat, character, persona, global).
  Your static Isekai cards are never written to. Unmanaged entries you add to the dynamic book are never touched.
* Entries carry `DL:<entityId> | Name [type]` in their *comment* field, which is how managed entries are found.
  Only `key`, `content`, `comment`, `disable` are ever changed on update; order/depth/probability/etc. you set survive.
* **Candidates** are just entities that do not (yet) satisfy the promotion rule — pure derived state.
  Promotion = confidence ≥ min AND importance ≥ min AND (seen in ≥ N separate scenes OR importance ≥ "single-appearance" level), per-type configurable.
* **Integrity layers** (prompt *and* code): fact status classes; verbatim-evidence quote must exist in the cited
  message (strict mode drops otherwise); "confirmed" text containing future/claim/hedge wording is demoted;
  protagonist cards and thought/feeling/decision facts are dropped; romantic relations need `explicit`;
  output is whitelisted, length-capped, stripped of HTML/`{{macros}}`/regex-style keys.
* **Conflicts**: single-valued slots (occupation, residence, ...). A later different value is a contradiction unless the
  story flags a change. Policy: keep both `[disputed]` / newer supersedes (history kept) / hold & ask. Refinements
  ("herbalist" -> "herbalist and shop owner") merge. Explicit player statements can win (setting).
* **Static lore**: entities matching a static card (name/keys) become a *delta* card containing only facts the static
  card doesn't already state, sharing the static keys; or are ignored (setting).
* **Cost control**: batches of up to 12 *new* messages (+3 context) every 6 messages; the newest 2 messages are
  skipped (swipe buffer); known-entity digest instead of history; no per-turn call; runs only when generation is idle.

## 3. Current-SillyTavern dependencies (and confidence)

| Dependency | Source | Status |
|---|---|---|
| `SillyTavern.getContext()` incl. `chat`, `chatMetadata`, `saveMetadata`, `eventSource`, `eventTypes`, `loadWorldInfo`, `saveWorldInfo`, `reloadWorldInfoEditor`, `updateWorldInfoList`, `getWorldInfoNames`, `generateRaw`, `ConnectionManagerRequestService`, `Popup`, `renderExtensionTemplateAsync`, `extensionSettings` | upstream `public/scripts/st-context.js` (staging) | **Verified** in source |
| `generateRaw({ prompt, systemPrompt, jsonSchema })` structured output | "Writing Extensions" docs | **Verified** in docs; ST maps schemas to Gemini `responseSchema` (so the schema is kept plain) |
| Events: `MESSAGE_RECEIVED/EDITED/DELETED/SWIPED/SENT`, `GENERATION_STARTED/ENDED/STOPPED`, `CHAT_CHANGED`, `WORLDINFO_UPDATED` | docs events list | Verified; unknown names are skipped safely |
| Chat Lorebook = `chat_metadata.world_info` | documented behaviour + other extensions | **Strongly corroborated, not read from source** — if binding fails you get a toast and can bind the book by hand |
| Creating a book = `saveWorldInfo(name, {entries:{}})` then `updateWorldInfoList()` | `/api/worldinfo/edit` endpoint described in docs | Corroborated; verify on first run |
| World Info entry field set | current schema (same fields used for your converted lorebooks) | Entry template mirrors it; ST fills defaults for anything missing |
| Branching copies chat metadata into the new chat | upstream behaviour as documented | **Not verified**. Design tolerates both: if the ledger is missing in a branch, use *Scan* to rebuild |
| `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, opts)` | context export verified; exact signature **not** verified | Optional path; default path is `generateRaw` |

Hard limits: no public API to read the *list of currently active* lorebooks (auto-detect reads the global
selector's DOM + character + chat bindings; extra books can be listed manually); only one native Chat Lorebook
slot exists, so if the chat already uses another Chat Lorebook, add the dynamic book as a *global* book.

## 4. Install

1. In SillyTavern, click Extensions → Install Extension
2. Enter this repository URL:
   [https://github.com/Prompt-And-Circumstance/StoryMode](https://github.com/RogerAllenDu/SillyTavern-LoreLedger)
3. Lore Ledger will appear in Extensions → Lore Ledger (Dynamic Story Lore)

## 5. Configure for Google AI Studio (Gemini) + Chat Completion

* API: Chat Completion → source **Google AI Studio**; connect with your key; pick a Gemini model.
* Leave **Model = Current Chat Completion connection** and **Use structured output** ticked. If the model
  returns unusable JSON the extension automatically retries once without the schema.
* The call uses your preset's *max response tokens*; keep ≥ 2000 (the extension requests 4000).
* Optional: create a cheaper Gemini **Connection Profile** (Connection Manager) and select it under *Model*.
* World Info: static books stay as they are (global/character). The extension creates and binds the dynamic
  book as the **Chat Lorebook**. In *World Info → Global settings* raise the **Budget** if you expect many entries;
  each dynamic card is capped (default 900 chars). Keep **Recursive scanning** as you prefer.
* Long stories: first run on an existing story, open dashboard → Tools → check the estimate → *Scan*. It processes
  12 messages per call and can be cancelled; ~1,000 messages ≈ 85 calls. Afterwards extraction is incremental.
* Starting values for a free-form fantasy story: every 6 messages, min confidence 0.6, min importance 3,
  single-appearance importance 8, apply mode **Review** for the first ~50 turns, then **Automatic**.

## 6. Acceptance tests

Automatic (everything except what a live model writes): `node test/run-tests.mjs` — 20 tests incl. T1–T12.

Manual, with a live model (use a scratch chat):
1. **T1** Write a scene with "a bartender named Bram" once; play 10 filler turns; Dashboard → Entities: Bram = candidate, no card.
2. **T2** Have Marla the herb seller appear, vanish for ~10 turns, return: card appears after the second scene.
3. **T3/T4** Visit a new village twice → location card; mention a village from your static book → no copy (a *delta* card only if new facts).
4. **T5** Give Elena a shop and a brother over several scenes → one card updated (same entry, History shows `update`).
5. **T6** Make an NPC lie about identity → card shows it only under "Claims (may be false)".
6. **T7** NPC announces a plan → under "Plans (not yet done)"; when it happens the plan disappears and a fact appears.
7. **T8** Friendly chat only → no "feels/decides/lover" facts, no Dragon card.
8. **T9** Swipe the message that introduced an NPC → card removed after the next sync (≈1 s); History → *undo* restores it; swipe back → it returns.
9. **T10** Branch from before a reveal, play differently → each branch's book matches its own messages.
10. **T11** Refer to a character three different ways → one entity (dashboard).
11. **T12** Try to make the story contradict a static card → static book unchanged; new facts only in a delta card.

## 7. Limits worth knowing

* Whether the model *obeys* the integrity rules is verified by code guards, not guaranteed; the strict evidence check
  and status demotion are what protect you. Review mode exists for the early turns.
* Metadata size: ledger ≈ 150–300 bytes per observation; use *Prune* occasionally.
* Edits to old messages are handled by signature: edited text becomes "new" and is rescanned; facts that cited the old text go dormant.
