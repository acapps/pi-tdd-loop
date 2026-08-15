# Remove monolith and wire module architecture

## Problem

After specs #1–#5, all event handler logic lives in the `src/events/` module tree. `src/events.ts` still exists as a compatibility shim that delegates to the modules. It should be removed.

## Target

Eliminate `src/events.ts`. The extension's entry point imports directly from `src/events/index.ts` and the individual modules.

## Changes

1. Update extension registration (`src/commands.ts` or wherever events are wired) to import from `src/events/index.ts` instead of `src/events.ts`
2. Import individual handlers:
   ```typescript
   import { handleSessionStart } from "./events/session-start";
   import { handleBeforeAgent } from "./events/before-agent";
   import { handleToolCall } from "./events/tool-call";
   import { handleAgentSettled } from "./events/agent-settled";
   ```
3. Remove `src/events.ts` entirely
4. Clean up `src/events/index.ts` to export all public handlers

## Acceptance Criteria

- [ ] `src/events.ts` does not exist
- [ ] Extension event registration imports from `src/events/` modules
- [ ] `src/events/index.ts` re-exports all handler types and functions
- [ ] All existing extension tests pass
- [ ] No behavioral change

## Dependencies

This spec depends on all previous specs (#1–#5) being complete.

## Risks

Low risk if all previous specs pass. This is a final cleanup — the behavior is already in the modules, this just removes the shim.
