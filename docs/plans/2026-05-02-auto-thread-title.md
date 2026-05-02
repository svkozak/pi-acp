# Auto Thread Title Generation Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Automatically set a short ACP/Zed thread title by spawning a separate Pi agent to summarize the user’s first real prompt.

**Architecture:** `pi-acp` detects the first non-slash user prompt for a session, spawns an isolated `pi --mode rpc` process dedicated to title generation, asks it to produce a short title, persists that title through existing `set_session_name`, then emits ACP `session_info_update`. This happens asynchronously and must not block the main assistant turn.

**Tech Stack:** TypeScript, Node.js, ACP SDK, existing `PiRpcProcess`, existing `session/update` flow, existing Pi RPC `set_session_name`.

---

## Checklist

- [x] Create local checkout at `/Users/rico/dev/packages/pi-acp`.
- [x] Create branch `auto-thread-title`.
- [x] Save this implementation plan in `docs/plans/2026-05-02-auto-thread-title.md`.
- [x] Install dependencies with `npm install` if needed.
- [x] Add title helper tests in `test/title.test.ts`.
- [x] Run title tests and verify they fail before implementation.
- [x] Add `src/acp/title.ts` helper functions.
- [x] Run title tests and verify they pass.
- [x] Inspect existing `src/acp/session.ts`, `src/acp/agent.ts`, and `src/pi-rpc/process.ts`.
- [x] Add auto-title session state and worker flow.
- [x] Ensure `/name` marks the title as manually set and prevents overwrite.
- [x] Add session-level behavior tests for first prompt, slash command skip, single-run guard, fallback, and manual override.
- [x] Add README documentation and optional `PI_ACP_AUTO_TITLE=false` escape hatch.
- [x] Run `npm run format`.
- [x] Run `npm run lint`.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [ ] Test via `pii-acp` wrapper by pointing it at the local built `pi-acp`.
- [ ] If successful, prepare PR to upstream `pi-acp`.

## Implementation Notes

### Title generation behavior

- Trigger only for the first non-empty, non-slash user prompt.
- Spawn a separate Pi RPC process for title generation so the main conversation remains clean.
- Ask for only a concise title: 3–7 words, no markdown, no quotes, no trailing punctuation.
- Sanitize model output before use.
- Fall back to a deterministic prompt-derived title if the title worker fails.
- Persist through `set_session_name` on the main session.
- Emit ACP:

```ts
session.emit({
  sessionUpdate: 'session_info_update',
  title,
  updatedAt: new Date().toISOString()
})
```

### Helper API

Create `src/acp/title.ts` with:

- `buildTitlePrompt(firstPrompt: string): string`
- `sanitizeGeneratedTitle(raw: string): string`
- `fallbackTitleFromPrompt(prompt: string): string`
- `shouldAutoTitlePrompt(message: string): boolean`

### Session integration

Add session state:

```ts
private autoTitleStarted = false;
private titleManuallySet = false;
```

Add methods:

```ts
maybeStartAutoTitle(firstPrompt: string): void
private async generateAndSetTitle(firstPrompt: string): Promise<void>
async setManualTitle(name: string): Promise<void>
```

Use `setManualTitle` from `/name` instead of directly calling `session.proc.setSessionName(name)`.

### Verification

Use local source checkout for development, then wire `pii-acp` to launch `/Users/rico/dev/packages/pi-acp/dist/index.js` for end-to-end Zed testing while preserving `varlock` behavior.
