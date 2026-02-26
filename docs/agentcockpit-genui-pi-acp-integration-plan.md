# GenUI + pi-acp Integration Plan for AgentCockpit

Date: 2026-02-26  
Scope: Integrate mobile-focused GenUI surfaces into AgentCockpit, including explicit compatibility with `ameno-/pi-acp`, while preserving existing `gateway_legacy`, generic ACP, and Codex behavior.

## 1. Current State Summary

- AgentCockpit already supports protocol modes in app settings:
  - `gateway_legacy`
  - `acp`
  - `codex`
- Transport and protocol layers are in place:
  - WebSocket lifecycle: `AgentCockpit/Core/Connection/ACGatewayConnection.swift`
  - Request/response service: `AgentCockpit/Core/Connection/ACSessionTransport.swift`
  - Event mapping + adapter routing: `AgentCockpit/Core/AppModel.swift`
  - Renderable domain events: `AgentCockpit/EventParsing/CanvasEvent.swift`
  - Canvas routing: `AgentCockpit/Features/Work/Canvas/EventCardRouter.swift`
- ACP support is currently minimal (`initialize`, `session/list`, `session/new`, `session/prompt`, and basic `session/update` mapping).
- There is no explicit `pi-acp` compatibility layer yet.
- There is no GenUI event type/renderer in the current canvas.

## 2. Where GenUI Trigger Routing Must Live

Use explicit contract-based routing in adapter layer, not heuristic text detection.

- Primary routing point:
  - `AppModel.handleMessage(_:)` in `AgentCockpit/Core/AppModel.swift`
- Protocol-specific mapping points:
  - ACP: `JSONRPCEventAdapter.mapACP(...)`
  - Codex: `JSONRPCEventAdapter.mapCodex(...)`
- Render routing point:
  - `EventCardRouter` switch in `AgentCockpit/Features/Work/Canvas/EventCardRouter.swift`

Rule:
- If payload matches GenUI trigger contract and validates schema, emit `.genUI(...)`.
- If validation fails or payload is unsupported, degrade to safe fallback (`.rawOutput(...)`) with reason metadata.

## 3. GenUI Trigger Contract (Authoritative)

The agent should trigger GenUI through explicit, machine-detectable protocol signals:

1. Contract identity:
   - method/kind/tool marker for GenUI (for ACP and Codex)
2. Payload:
   - SurfaceSpec JSON with versioned schema (`v0`) and stable surface id
3. Update modes:
   - full snapshot and/or patch updates
4. Validation:
   - required fields, schema version check, known component types, safe size limits
5. Client behavior:
   - never infer GenUI from plain prose
   - only render when contract + validation pass

## 4. Rendering Strategy for iOS

Recommended path: native SwiftUI renderer from SurfaceSpec (not React runtime in WKWebView).

Why:
- Cockpit is already native SwiftUI.
- Keeps render pipeline aligned with existing `CanvasEvent -> EventCardRouter` architecture.
- Better mobile performance, accessibility, and integration with app state.
- Avoids hybrid web bridge complexity for interaction callbacks and persistence.

## 5. pi-acp Integration Requirements

`pi-acp` must be integrated as a first-class ACP compatibility target.

Deliverables:
1. Compatibility matrix for `ameno-/pi-acp` method/param/result/event variants.
2. ACP transport + adapter updates to handle `pi-acp` variants without regressing generic ACP.
3. Fixture/e2e verification against `pi-acp` runtime:
   - initialize lifecycle
   - session list/new/prompt
   - update notifications
   - GenUI contract routing and fallback behavior
4. Optional UX profile preset in Settings for easy `pi-acp` endpoint setup.

## 6. Implementation Phases

1. Define contract and schema validation rules.
2. Add GenUI event model to canvas domain.
3. Implement `pi-acp` compatibility matrix and parser adjustments.
4. Extend ACP adapter mapping for GenUI events.
5. Extend Codex adapter mapping for GenUI events.
6. Add store merge/upsert logic for snapshot + patch updates.
7. Build native SwiftUI GenUI renderer and `EventCardRouter` integration.
8. Wire GenUI action callbacks back through `ACSessionTransport`.
9. Add feature flag, logging, and safe fallback behavior.
10. Add fixture/e2e verification gates (ACP, Codex, and `pi-acp`).
11. Execute final rollout gate with explicit pass/fail criteria.

## 7. Verification Gate (Must Pass Before Rollout)

1. iOS build passes using FlowDeck.
2. Legacy gateway behavior unchanged.
3. ACP non-GenUI behavior unchanged.
4. Codex non-GenUI behavior unchanged.
5. `pi-acp` session lifecycle works end-to-end.
6. GenUI payload renders in Work view for ACP and Codex.
7. GenUI interactive action callback round-trip works for ACP and Codex.
8. Invalid GenUI payloads never crash UI and fall back safely.
9. Evidence captured with deterministic fixtures/tests.

## 8. Beads Backlog (Created)

Epic:
- `ac-e3p` Integrate GenUI Into AgentCockpit (ACP + Codex)

Core GenUI beads:
- `ac-e3p.1` Define GenUI trigger contract and payload schema
- `ac-e3p.2` Add GenUI event model to canvas domain
- `ac-e3p.3` Map ACP `session/update` notifications to GenUI events
- `ac-e3p.4` Map Codex item notifications/tool outputs to GenUI events
- `ac-e3p.5` Add GenUI merge/upsert behavior in `AgentEventStore`
- `ac-e3p.6` Implement native SwiftUI GenUI renderer and route card
- `ac-e3p.7` Wire GenUI action callbacks to protocol transport
- `ac-e3p.8` Add GenUI feature flag, observability, and safe fallback
- `ac-e3p.9` Build fixture-based verification for ACP and Codex GenUI paths
- `ac-e3p.11` Gate: GenUI integration ready for cockpit rollout

pi-acp beads:
- `ac-e3p.12` Baseline `pi-acp` compatibility matrix (`ameno-/pi-acp`)
- `ac-e3p.13` Implement `pi-acp` ACP compatibility in transport + adapter
- `ac-e3p.14` Add `pi-acp` integration harness and end-to-end verification
- `ac-e3p.15` Add `pi-acp` endpoint profile in Settings UX

## 9. Dependency Highlights (Critical Path)

1. `ac-e3p.12` blocks `ac-e3p.1` and `ac-e3p.15`.
2. `ac-e3p.13` depends on `ac-e3p.12`, `ac-e3p.1`, `ac-e3p.2`.
3. `ac-e3p.3` depends on `ac-e3p.13` (ensures ACP GenUI mapping is `pi-acp` compatible).
4. `ac-e3p.14` depends on `ac-e3p.13`, `ac-e3p.6`, `ac-e3p.7`.
5. `ac-e3p.9` and final gate `ac-e3p.11` both depend on `ac-e3p.14`.

This guarantees rollout cannot complete without verified `pi-acp` integration.

## 10. Execution Order

1. Start `ac-e3p.12` (compatibility matrix).
2. Complete `ac-e3p.1` and `ac-e3p.2`.
3. Complete `ac-e3p.13`.
4. Complete `ac-e3p.3` and `ac-e3p.4`.
5. Complete `ac-e3p.5` and `ac-e3p.6`.
6. Complete `ac-e3p.7` and `ac-e3p.8`.
7. Complete `ac-e3p.14` and `ac-e3p.15`.
8. Complete `ac-e3p.9`.
9. Close `ac-e3p.11` only after all gate criteria pass.

