/**
 * Session spend caps and the cost-HUD rail — HUD P0 engineering layer
 * (U-1 predictive rail, U-2 runaway-guard signal, U-3 per-call ceiling).
 *
 * Division of responsibility (INV-5: caps are enforced server-side; the
 * client renders but cannot bypass):
 * - The GATEWAY enforces. The mock gateway demonstrates the contract with
 *   HTTP 402 responses carrying machine-readable codes; the production
 *   gateway implements the same contract at the key. The client-side
 *   per-call check here is advisory pre-flight only — a projection, not a
 *   wall.
 * - This module is the CLIENT data layer: it turns the metering event
 *   stream into the rail readings the HUD renders (U-1), and emits the
 *   single pre-flight projection signal U-2 needs. It never auto-downgrades
 *   a call and never repeats a warning.
 *
 * Open founder decisions are deliberately not assumed:
 * - D-c (cap scope): the default ledger is session-scoped; per-day/per-key
 *   aggregation is a config change, not a redesign.
 * - D-d (cheaper-model escape): the projection reports the crossing and
 *   names the cheaper model when one is derivable from the price table;
 *   acting on it stays with the caller.
 *
 * Exactness: spend accumulates in integer nano-USD (each metering event's
 * `costUsd` is an exact decimal, so `round(costUsd * 1e9)` recovers its
 * numerator), and only the final reading converts to a USD number.
 */
import type { MeteringEvent, PriceTable } from "./metering.js";

/** Configuration for a {@link SessionCapLedger}. */
export interface SessionCapConfig {
  /**
   * Session spend cap in USD. `undefined` = uncapped: the rail still renders
   * burn rate, but time-to-cap and warning crossings are always `null`.
   */
  capUsd?: number;
  /**
   * Hard maximum for a single call in USD (U-3). Advisory client-side
   * pre-flight; the gateway enforces the real limit.
   */
  perCallCeilingUsd?: number;
  /**
   * Fraction of the cap where the U-2 warning fires (default 0.8). The
   * warning fires at most once per ledger.
   */
  crossingThreshold?: number;
  /** Clock for burn-rate math; injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

/** A single call's pre-flight projection (U-2's product signal). */
export interface CallProjection {
  /** Exact USD cost of the call at the given price table. */
  readonly projectedCostUsd: number;
  /** Session spend after this call, USD (exact decimal arithmetic). */
  readonly spendAfterUsd: number;
  /** Remaining cap after this call, USD; `null` when uncapped. */
  readonly remainingAfterUsd: number | null;
  /** `false` when the projection exceeds the per-call ceiling (U-3). */
  readonly withinPerCallCeiling: boolean;
  /**
   * The one-shot U-2 warning: set only when THIS call first crosses the
   * threshold; `null` before, after, or when uncapped.
   */
  readonly warning: string | null;
}

/** What the cost HUD rail renders (U-1). */
export interface RailReading {
  /** Session spend so far, USD. */
  readonly spendUsd: number;
  /** Session cap, USD; `null` when uncapped. */
  readonly capUsd: number | null;
  /** Cap minus spend, USD; `null` when uncapped. */
  readonly remainingUsd: number | null;
  /** Observed burn rate, USD per minute; `null` until two events exist. */
  readonly burnRatePerMin: number | null;
  /** Minutes of burn until the cap is hit at the observed rate; `null` when uncapped or no burn. */
  readonly timeToCapMin: number | null;
  /** Metered events observed (the rail's sample size). */
  readonly events: number;
  /** ISO-8601 instant of the reading (the "now" tick). */
  readonly now: string;
}

const NANO = 1_000_000_000;
const DEFAULT_THRESHOLD = 0.8;

/**
 * Session-scoped spend ledger over the metering event stream.
 *
 * Attach it to the same sink the HUD reads (or feed `event`s directly) and
 * ask it for rail readings and call projections. The warning is one-shot:
 * the first projection that lands at or beyond the threshold sets
 * `warningFired`, and no later projection warns again.
 */
export interface SessionCapLedger {
  /** Feed one metering event (as emitted by the client on every completion). */
  record(event: MeteringEvent): void;
  /** Spend so far in USD (exact within nano-USD integer accumulation). */
  spendUsd(): number;
  /** The U-1 rail reading. */
  railReading(): RailReading;
  /** The U-2/U-3 pre-flight projection for one call. */
  projectCall(input: {
    model: string;
    promptTokens: number;
    maxCompletionTokens: number;
    priceTable: PriceTable;
  }): CallProjection;
  /** Whether the one-shot warning has fired. */
  warningFired(): boolean;
}

/** Create a session cap ledger (see {@link SessionCapConfig}). */
export function createSessionCapLedger(config: SessionCapConfig = {}): SessionCapLedger {
  const capNano = config.capUsd === undefined ? null : Math.round(config.capUsd * NANO);
  const ceilingNano =
    config.perCallCeilingUsd === undefined ? null : Math.round(config.perCallCeilingUsd * NANO);
  const threshold = config.crossingThreshold ?? DEFAULT_THRESHOLD;
  const now = config.now ?? Date.now;
  if (capNano !== null && capNano < 0) {
    throw new RangeError(`capUsd must be non-negative, got ${config.capUsd}`);
  }
  if (ceilingNano !== null && ceilingNano < 0) {
    throw new RangeError(`perCallCeilingUsd must be non-negative, got ${config.perCallCeilingUsd}`);
  }
  if (!(threshold > 0 && threshold <= 1)) {
    throw new RangeError(`crossingThreshold must be in (0, 1], got ${threshold}`);
  }

  let spendNano = 0;
  let events = 0;
  let windowStartMs: number | null = null;
  let windowLastMs: number | null = null;
  let warned = false;

  return {
    record(event: MeteringEvent): void {
      spendNano += Math.round(event.costUsd * NANO);
      events += 1;
      const at = Date.parse(event.timestamp);
      if (Number.isFinite(at)) {
        windowStartMs ??= at;
        windowLastMs = at;
      }
    },
    spendUsd(): number {
      return spendNano / NANO;
    },
    railReading(): RailReading {
      const remainingNano = capNano === null ? null : capNano - spendNano;
      let burnRatePerMin: number | null = null;
      if (windowStartMs !== null && windowLastMs !== null && events >= 2) {
        const minutes = Math.max((windowLastMs - windowStartMs) / 60_000, 1 / 60);
        burnRatePerMin = spendNano / NANO / minutes;
      }
      let timeToCapMin: number | null = null;
      if (remainingNano !== null && remainingNano > 0 && burnRatePerMin !== null && burnRatePerMin > 0) {
        timeToCapMin = remainingNano / NANO / burnRatePerMin;
      }
      return {
        spendUsd: spendNano / NANO,
        capUsd: capNano === null ? null : capNano / NANO,
        remainingUsd: remainingNano === null ? null : remainingNano / NANO,
        burnRatePerMin,
        timeToCapMin,
        events,
        now: new Date(now()).toISOString(),
      };
    },
    projectCall({ model, promptTokens, maxCompletionTokens, priceTable }): CallProjection {
      const usage = {
        promptTokens,
        completionTokens: maxCompletionTokens,
        totalTokens: promptTokens + maxCompletionTokens,
      };
      const projectedNano = Math.round(priceTable.costUsd(model, usage) * NANO);
      const spendAfterNano = spendNano + projectedNano;
      const remainingAfterNano = capNano === null ? null : capNano - spendAfterNano;

      let warning: string | null = null;
      if (capNano !== null && !warned) {
        const beforeNano = spendNano;
        const thresholdNano = capNano * threshold;
        if (beforeNano < thresholdNano && spendAfterNano >= thresholdNano) {
          warned = true;
          warning =
            `projected call $${projectedNano / NANO} crosses ${(threshold * 100).toFixed(0)}% of the session cap $${capNano / NANO}`;
        }
      }

      return {
        projectedCostUsd: projectedNano / NANO,
        spendAfterUsd: spendAfterNano / NANO,
        remainingAfterUsd: remainingAfterNano === null ? null : remainingAfterNano / NANO,
        withinPerCallCeiling: ceilingNano === null || projectedNano <= ceilingNano,
        warning,
      };
    },
    warningFired(): boolean {
      return warned;
    },
  };
}

/** Estimated token counts for a call (see {@link estimateCallCostUsd}). */
export interface CallEstimate {
  model: string;
  promptTokens: number;
  maxCompletionTokens: number;
}

/**
 * Price one call for pre-flight projection: prompt tokens plus the full
 * `maxCompletionTokens` allowance at the table's completion rate — the
 * ceiling-safe estimate, since a call cannot bill more tokens than it is
 * allowed to emit.
 */
export function estimateCallCostUsd(estimate: CallEstimate, priceTable: PriceTable): number {
  return priceTable.costUsd(estimate.model, {
    promptTokens: estimate.promptTokens,
    completionTokens: estimate.maxCompletionTokens,
    totalTokens: estimate.promptTokens + estimate.maxCompletionTokens,
  });
}

/** Error thrown by the advisory client-side per-call ceiling check (U-3). */
export class PerCallCeilingExceededError extends Error {
  readonly projectedCostUsd: number;
  readonly ceilingUsd: number;

  constructor(projectedCostUsd: number, ceilingUsd: number) {
    super(
      `projected call cost $${projectedCostUsd} exceeds the per-call ceiling $${ceilingUsd} — gateway would refuse (INV-5); use a smaller max_tokens or a cheaper model`,
    );
    this.name = "PerCallCeilingExceededError";
    this.projectedCostUsd = projectedCostUsd;
    this.ceilingUsd = ceilingUsd;
  }
}
