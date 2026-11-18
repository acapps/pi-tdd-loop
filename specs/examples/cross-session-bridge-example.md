# Example: Design → Loop Feedback Cycle

This scenario walks through the cross-session bridge automating the feedback loop between a design session and a pi-tdd-loop session.

## Setup

**Project:** `~/projects/my-api` (TypeScript, vitest)

**Session A (design):** Pi session with local LLM, working on `my-api`. Has full project context, open PRs, recent changes.

**Session B (loop):** Pi session with pi-tdd-loop, running `/loop specs/auth-refresh.md`.

Both sessions share the same filesystem. Spec file: `~/projects/my-api/specs/auth-refresh.md`.

## Round 1: Tester finds gaps

**Session B starts the loop:**
```bash
/loop specs/auth-refresh.md
```

Phase 0 runs. The Reviewer finds:
- Ambiguity: "refresh token rotation" doesn't specify if old token is revoked immediately or grace period
- Missing edge case: concurrent refresh requests from same client
- Underspecified: error response format on rotation failure

**Bridge auto-captures findings:**
```
[BRIDGE] Phase 0 findings captured (3 items)
[BRIDGE] Pushing to session A (abc123)...
[BRIDGE] session_send_message sent
```

## Round 1: Design session updates spec

**Session A receives the message:**
```
[pi-sessions] Message from session def456 (loop):
Phase 0 findings for specs/auth-refresh.md:
1. Ambiguity: refresh token rotation — immediate revoke or grace period?
2. Missing edge case: concurrent refresh requests
3. Underspecified: error response format on rotation failure
```

**Session A has full context.** It reads the spec, reviews the findings, and updates the file:
```markdown
## Behavior (updated)
- Token rotation: old token revoked immediately (no grace period)
- Concurrent requests: second request returns 409 Conflict if rotation in progress
- Error format: `{ "error": "rotation_failed", "retry_after": <seconds> }`
```

**Bridge detects file change:**
```
[BRIDGE] Spec file changed: specs/auth-refresh.md
[BRIDGE] Triggering /loop-patch specs/auth-refresh.md...
[BRIDGE] Patch sent. Round 1/3 complete.
```

## Round 2: Tester re-reads, finds more

Phase 0 re-runs with updated spec. Reviewer finds:
- Still missing: what happens to active sessions when token is rotated

**Bridge captures → pushes → Session A updates again.**

```
[BRIDGE] Phase 0 findings captured (1 item)
[BRIDGE] Pushing to session A...
[BRIDGE] Spec file changed: specs/auth-refresh.md
[BRIDGE] Triggering /loop-patch...
[BRIDGE] Patch sent. Round 2/3 complete.
```

## Round 2: Clean review

Phase 0 re-runs. Reviewer finds no issues. Auto-approve → Phase A.

```
[BRIDGE] Phase 0 clean. Bridge stopping.
[BRIDGE] Feedback rounds: 2. Final state: Phase A (Tester writing tests).
```

## Fallback: No pi-sessions

If `pi-sessions` isn't installed, bridge writes findings to a sidecar file:

```
[BRIDGE] session_send_message unavailable. Writing fallback.
[BRIDGE] Findings written to specs/auth-refresh.md.bridge-findings.md
[BRIDGE] Session A: read the findings file, update spec, save.
```

Session A watches the findings file (or user reads it manually). Bridge still detects spec changes and triggers `/loop-patch` automatically.

## Commands

```bash
# Session B: start the bridge
/bridge-start abc123 ~/projects/my-api/specs/auth-refresh.md

# Session B: check status
/bridge-status
# → Round 2/3, last finding: "active sessions on rotation"

# Session B: stop early
/bridge-stop
# → Cancels watchers, bridge idle
```

## What makes this work

1. **Session A has context** — it's not starting cold. It knows the project, the PRs, the recent changes. It can make better spec decisions than the loop's Tester alone.

2. **Session B has structure** — pi-tdd-loop's Phase 0 Reviewer is systematic. It catches gaps the design session missed because it was thinking about the feature, not the contract.

3. **The bridge is thin** — it doesn't add loop features. It only automates the copy-paste-between-sessions that was already the workflow.

4. **It stops** — 3-round max means it escalates to human judgment before becoming an endless loop of "still not enough info."
