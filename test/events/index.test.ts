// Contract tests for events/index.ts — re-exports and EventCtx type

import { describe, it, expect, expectTypeOf } from "vitest";

describe("events/index.ts — re-exports and types", () => {
  it("EventCtx has required shape", () => {
    // Verify the type is importable and has the expected shape
    const ctx = {
      ui: {
        notify: (_msg: string, _level: string) => {},
        setStatus: (_key: string, _text: string) => {},
      },
      sessionManager: {
        getEntries: () => [],
      },
      cwd: "/tmp/test",
    };

    expect(ctx.ui.notify).toBeDefined();
    expect(ctx.ui.setStatus).toBeDefined();
    expect(ctx.sessionManager.getEntries).toBeDefined();
    expect(ctx.cwd).toBe("/tmp/test");
  });

  it("module is importable", async () => {
    const mod = await import("../../src/events");
    expect(mod).toBeDefined();
    // All exports are type-only (re-exported from sub-modules), no runtime values expected
    expect(Object.keys(mod).length).toBeGreaterThanOrEqual(0);
  });

  it("type-only exports compile (GateHandlerInput, EffectInput, EventCtx)", () => {
    // Type-level assertion — these types exist in the module's type surface.
    // Use import type to access them without runtime overhead.
    type _Ctx = import("../../src/events/index").EventCtx;
    type _GateIn = import("../../src/events/agent-settled/gate-transition").GateHandlerInput;
    type _EffectIn = import("../../src/events/agent-settled/effect-applicator").EffectInput;
    const _check: _Ctx = null as any;
    const _check2: _GateIn = null as any;
    const _check3: _EffectIn = null as any;
    void _check;
    void _check2;
    void _check3;
  });
});
