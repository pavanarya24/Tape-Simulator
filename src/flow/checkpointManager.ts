/**
 * CheckpointManager — manages immutable checkpoints for high-frequency replay acceleration.
 *
 * Provides O(1) direct interval lookup for fixed-cadence checkpoints (default K = 10,000),
 * allowing any arbitrary forward or backward seek across millions of events to complete
 * by restoring the nearest checkpoint C <= target and replaying at most (K - 1) events.
 */

import type { FlowEngineCheckpoint } from "./training";

export const DEFAULT_CHECKPOINT_INTERVAL = 10_000;

export interface CheckpointManagerOptions {
  /** Checkpoint cadence in event count (default 10,000). */
  interval?: number;
}

export class CheckpointManager {
  readonly interval: number;
  private readonly checkpoints = new Map<number, FlowEngineCheckpoint>();
  private maxCapturedIndex = -1;

  constructor(options: CheckpointManagerOptions = {}) {
    this.interval = Math.max(1, Math.floor(options.interval ?? DEFAULT_CHECKPOINT_INTERVAL));
  }

  /** Total number of checkpoints currently stored. */
  size(): number {
    return this.checkpoints.size;
  }

  /** True if a checkpoint is recorded for the exact eventIndex. */
  has(eventIndex: number): boolean {
    return this.checkpoints.has(eventIndex);
  }

  /** Retrieve a checkpoint by exact eventIndex, if recorded. */
  get(eventIndex: number): FlowEngineCheckpoint | undefined {
    return this.checkpoints.get(eventIndex);
  }

  /**
   * Save a checkpoint.
   * By default does not overwrite an existing checkpoint at the same index to prevent churn.
   */
  save(checkpoint: FlowEngineCheckpoint, overwrite = false): boolean {
    if (!overwrite && this.checkpoints.has(checkpoint.eventIndex)) {
      return false;
    }
    this.checkpoints.set(checkpoint.eventIndex, checkpoint);
    if (checkpoint.eventIndex > this.maxCapturedIndex) {
      this.maxCapturedIndex = checkpoint.eventIndex;
    }
    return true;
  }

  /**
   * Determine if a checkpoint should be captured at this eventIndex.
   * Returns true for 0 and any positive multiple of interval that has not yet been recorded.
   */
  shouldCapture(eventIndex: number): boolean {
    if (eventIndex < 0) return false;
    if (this.checkpoints.has(eventIndex)) return false;
    return eventIndex === 0 || eventIndex % this.interval === 0;
  }

  /**
   * Find nearest stored checkpoint where checkpoint.eventIndex <= target.
   *
   * Uses O(1) interval math:
   *   multiple = floor(target / interval) * interval
   * If the multiple exists in storage, it is returned in O(1).
   * Otherwise falls back to highest captured checkpoint <= target or initial state at 0.
   */
  findNearest(target: number): FlowEngineCheckpoint | null {
    if (target < 0) return null;

    // Check exact match first
    const exact = this.checkpoints.get(target);
    if (exact) return exact;

    // Direct interval multiple
    const multiple = Math.floor(target / this.interval) * this.interval;
    const direct = this.checkpoints.get(multiple);
    if (direct) return direct;

    // If target multiple exceeds current max captured checkpoint, use max captured checkpoint
    if (multiple > this.maxCapturedIndex && this.maxCapturedIndex >= 0) {
      const maxCp = this.checkpoints.get(this.maxCapturedIndex);
      if (maxCp && maxCp.eventIndex <= target) return maxCp;
    }

    // Direct step down across multiples (typically 1-2 iterations if any)
    for (let idx = multiple - this.interval; idx >= 0; idx -= this.interval) {
      const cp = this.checkpoints.get(idx);
      if (cp) return cp;
    }

    // Fallback to initial checkpoint at 0
    return this.checkpoints.get(0) ?? null;
  }

  /** Clear all checkpoints and reset indexing. */
  clear(): void {
    this.checkpoints.clear();
    this.maxCapturedIndex = -1;
  }

  /** List all stored checkpoint event indices in ascending numerical order. */
  indices(): number[] {
    return [...this.checkpoints.keys()].sort((a, b) => a - b);
  }
}
