// Unit tests for src/state/checkpoint.ts — createStateCheckpointManager.
//
// Contract (from checkpoint.ts):
//   - createSnapshot writes a `<phase>:<round>.json` file to the snapshot dir
//     and stores the snapshot in an in-memory map keyed by that key.
//   - restoreSnapshot returns the stored snapshot for a key, or null when the
//     key is unknown.
//   - flush clears the map and returns a default review/round-0 snapshot with
//     snapshotId "snap-phase0-initial".
//   - listSnapshots returns every stored snapshot (insertion order).
//   - nextSnapshotId starts at 1.
//
// No vi.mock: real node:fs in a temp dir, cleaned up after each test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStateCheckpointManager } from "../src/state/checkpoint";
import type { LoopStateSnapshot } from "../src/state/checkpoint";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let dir: string;

function snapshot(overrides: Partial<LoopStateSnapshot> = {}): LoopStateSnapshot {
  // Cast: the zod schema defaults the optional string fields to "", so the
  // inferred input type marks them optional while the stored type requires
  // them. The checkpoint manager stores the object as-is (no zod parse), so
  // the cast is safe for this test fixture.
  return {
    phase: "A",
    round: 2,
    snapshotId: "snap-1",
    transcriptTokenCount: 10,
    ...overrides,
  } as LoopStateSnapshot;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-checkpoint-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createStateCheckpointManager — basics", () => {
  it("exposes the snapshot dir and an initial nextSnapshotId of 1", () => {
    const mgr = createStateCheckpointManager(dir);
    expect(mgr.snapshotDir).toBe(dir);
    expect(mgr.nextSnapshotId).toBe(1);
    expect(mgr.checkpoints.size).toBe(0);
  });

  it("returns an empty list before any snapshot is created", () => {
    const mgr = createStateCheckpointManager(dir);
    expect(mgr.listSnapshots()).toEqual([]);
  });
});

describe("createSnapshot", () => {
  it("stores the snapshot in the map keyed by phase:round", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "B", round: 3 }));
    expect(mgr.listSnapshots()).toHaveLength(1);
    expect(mgr.checkpoints.get("B:3")).toMatchObject({ phase: "B", round: 3 });
  });

  it("writes a phase:round.json file to disk with the snapshot contents", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "C", round: 1, transcriptTokenCount: 77 }));

    const file = path.join(dir, "C:1.json");
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8")) as LoopStateSnapshot;
    expect(onDisk).toMatchObject({ phase: "C", round: 1, transcriptTokenCount: 77 });
  });

  it("overwrites the file for a repeated key but keeps a single map entry", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "A", round: 1, result: "first" }));
    mgr.createSnapshot(snapshot({ phase: "A", round: 1, result: "second" }));

    expect(mgr.listSnapshots()).toHaveLength(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "A:1.json"), "utf-8")) as LoopStateSnapshot;
    expect(onDisk.result).toBe("second");
  });

  it("keeps distinct snapshots for distinct phase:round keys", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "A", round: 1 }));
    mgr.createSnapshot(snapshot({ phase: "A", round: 2 }));
    mgr.createSnapshot(snapshot({ phase: "B", round: 1 }));
    expect(mgr.listSnapshots()).toHaveLength(3);
  });
});

describe("restoreSnapshot", () => {
  it("returns the stored snapshot for a known key", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "B", round: 4, task: "fix parser" }));
    expect(mgr.restoreSnapshot("B:4")).toMatchObject({ phase: "B", round: 4, task: "fix parser" });
  });

  it("returns null for an unknown key", () => {
    const mgr = createStateCheckpointManager(dir);
    expect(mgr.restoreSnapshot("Z:99")).toBeNull();
  });

  it("returns null when nothing has been created", () => {
    const mgr = createStateCheckpointManager(dir);
    expect(mgr.restoreSnapshot("A:1")).toBeNull();
  });
});

describe("flush", () => {
  it("clears the in-memory map", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "A", round: 1 }));
    mgr.createSnapshot(snapshot({ phase: "B", round: 2 }));
    mgr.flush();
    expect(mgr.listSnapshots()).toEqual([]);
    expect(mgr.checkpoints.size).toBe(0);
  });

  it("returns a default review/round-0 snapshot with the pinned snapshotId", () => {
    const mgr = createStateCheckpointManager(dir);
    const def = mgr.flush();
    expect(def.phase).toBe("review");
    expect(def.round).toBe(0);
    expect(def.snapshotId).toBe("snap-phase0-initial");
    expect(def.transcriptTokenCount).toBe(0);
  });
});

describe("listSnapshots", () => {
  it("returns snapshots in insertion order", () => {
    const mgr = createStateCheckpointManager(dir);
    mgr.createSnapshot(snapshot({ phase: "A", round: 1 }));
    mgr.createSnapshot(snapshot({ phase: "B", round: 1 }));
    mgr.createSnapshot(snapshot({ phase: "C", round: 1 }));
    expect(mgr.listSnapshots().map(s => `${s.phase}:${s.round}`)).toEqual(["A:1", "B:1", "C:1"]);
  });
});
