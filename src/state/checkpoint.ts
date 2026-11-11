import * as fs from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// --- Types ---

const SnapshotSchema = z.object({
  phase: z.string(),
  round: z.number().int().min(0),
  currentSpec: z.string().optional().default(""),
  currentPlan: z.string().optional().default(""),
  task: z.string().optional().default(""),
  result: z.string().optional().default(""),
  metadata: z.string().optional().default(""),
  transcriptSummary: z.string().optional().default(""),
  snapshotId: z.string(),
  timestamp: z.string().optional().default(""),
  agent: z.string().optional().default(""),
  transcriptTokenCount: z.number().int().min(0),
});

export type LoopStateSnapshot = z.infer<typeof SnapshotSchema>;

export interface StateCheckpointManager {
  readonly checkpoints: Map<string, LoopStateSnapshot>;
  readonly snapshotDir: string;
  readonly nextSnapshotId: number;
  createSnapshot(state: LoopStateSnapshot): void;
  restoreSnapshot(path: string): LoopStateSnapshot | null;
  flush(): LoopStateSnapshot;
  listSnapshots(): LoopStateSnapshot[];
}

export function createStateCheckpointManager(dir: string): StateCheckpointManager {
  return new StateCheckpointManagerImpl(dir);
}

// --- Implementation ---

class StateCheckpointManagerImpl implements StateCheckpointManager {
  readonly checkpoints = new Map<string, LoopStateSnapshot>();
  readonly snapshotDir: string;
  readonly nextSnapshotId = 1;

  constructor(dir: string) {
    this.snapshotDir = dir;
  }

  private mkKey(phase: string, round: number): string {
    return `${phase}:${round}`;
  }

  createSnapshot(state: LoopStateSnapshot): void {
    const key = this.mkKey(state.phase, state.round);
    this.writeSnapshotFile(key, state);
    this.checkpoints.set(key, state);
  }

  restoreSnapshot(path: string): LoopStateSnapshot | null {
    return this.checkpoints.get(path) ?? null;
  }

  flush(): LoopStateSnapshot {
    this.checkpoints.clear();
    return {
      phase: "review",
      round: 0,
      currentSpec: "",
      currentPlan: "",
      task: "",
      result: "",
      metadata: "",
      transcriptSummary: "",
      snapshotId: "snap-phase0-initial",
      timestamp: new Date().toISOString(),
      agent: "",
      transcriptTokenCount: 0,
    };
  }

  listSnapshots(): LoopStateSnapshot[] {
    return [...this.checkpoints.values()];
  }

  private writeSnapshotFile(key: string, state: LoopStateSnapshot): void {
    const dir = this.snapshotDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(join(dir, `${key}.json`), JSON.stringify(state, null, 2));
  }
}
