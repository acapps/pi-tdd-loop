// /loop-checkpoint — list and restore state snapshots, or flush to reset.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState } from "../types";
import type { DebugFn } from "../events";
import { StateCheckpointManager } from "../state/checkpoint";

/**
 * /loop-checkpoint <[snapshot-id][]> — list available snapshots,
 * or restore a specific one. With no args, flushes to Phase 0 review.
 */
export function cmdCheckpoint(state: { current: LoopState & { checkpointManager: StateCheckpointManager } }) {
  return {
    description: "List snapshots or restore a specific one. With no args, flushes to Phase 0 review.",
    handler: async (args: string, ctx: CommandContext) => {
      const manager = state.current.checkpointManager;
      if (!manager) {
        ctx.ui.notify("Checkpoint manager not initialized. Run /loop to start.", "error");
        return;
      }

      const snapshotId = args.trim();
      if (snapshotId === "") {
        return listSnapshots(manager, ctx);
      }
      return restoreSnapshot(manager, snapshotId, ctx);
    },
  };
}

function listSnapshots(
  manager: StateCheckpointManager,
  ctx: CommandContext,
): string | undefined {
  const snapshots = manager.listSnapshots();
  if (snapshots.length === 0) {
    ctx.ui.notify("No snapshots found. Run /loop to start.", "info");
    return;
  }
  ctx.ui.notify("Available snapshots:", "info");
  for (const snap of snapshots) {
    ctx.ui.notify(`  ${snap.snapshotId} — ${snap.phase} r${snap.round} (${snap.timestamp})`);
  }
  return "Check the list above and specify a snapshot ID to restore.";
}

function restoreSnapshot(
  manager: StateCheckpointManager,
  snapshotId: string,
  ctx: CommandContext,
): string | undefined {
  try {
    const snap = manager.restoreSnapshot(snapshotId);
    if (!snap) {
      ctx.ui.notify(`Snapshot "${snapshotId}" not found.`, "error");
      return;
    }
    ctx.ui.notify(`Restored snapshot "${snapshotId}": Phase ${snap.phase}, round ${snap.round}`, "info");
    return `Restored ${snapshotId}.`;
  } catch (e: any) {
    ctx.ui.notify(`Failed to restore snapshot: ${e.message}`, "error");
    return;
  }
}
