/**
 * Usage metering for Latch gateway chat completions.
 *
 * Three concerns live here:
 * - {@link parseUsage} — parse the OpenAI-compatible `usage` object
 *   (`prompt_tokens`, `completion_tokens`, `total_tokens`) from a chat
 *   completion response.
 * - {@link PriceTable} — per-model USD-per-1k-token rates, loaded from the
 *   optional `product/identity/price-table.yaml`, used to price a usage into
 *   an exact `costUsd`.
 * - {@link createMeteringLog} — the default {@link MeteringSink}: an
 *   in-memory ring buffer of the last {@link DEFAULT_RING_CAPACITY} events
 *   plus a subscription API the cost HUD can attach to.
 *
 * Cost arithmetic is exact: rates are parsed into integer micro-USD (1e-6 USD)
 * per 1k tokens, a usage is priced as `tokens * microUsdPer1k` nano-USD
 * (the /1000 of "per 1k" cancels the micro→nano *1000), and only the final
 * `nanoUsd / 1e9` conversion to a JS number happens — so `costUsd` equals its
 * decimal literal exactly (e.g. 1500 prompt tokens at $0.003/1k plus 500
 * completion tokens at $0.015/1k is exactly `0.012`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Token counts parsed from a chat completion response's `usage` object. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Metering token counts for a response that carried no (valid) `usage`. */
export const ZERO_USAGE: Usage = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

/** One cost-accounting record per completed chat completion. */
export interface MeteringEvent {
  /** Model that served the request (gateway echo, else the requested model). */
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** USD cost priced from the price table; $0 when unpriced or unmetered. */
  readonly costUsd: number;
  /** Gateway response `id`; empty string when the gateway echoed none. */
  readonly requestId: string;
  /** ISO-8601 timestamp of when the response was metered. */
  readonly timestamp: string;
}

/**
 * Parse the OpenAI-compatible usage object.
 *
 * `prompt_tokens` and `completion_tokens` must be non-negative integers;
 * `total_tokens` defaults to their sum when absent. Anything else — a missing
 * `usage` field, a non-object, fractional or negative counts — returns
 * `undefined`, and the caller meters zero tokens at $0 rather than inventing
 * numbers.
 */
export function parseUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const promptTokens = tokenCount(record, "prompt_tokens");
  const completionTokens = tokenCount(record, "completion_tokens");
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }
  const totalTokens = tokenCount(record, "total_tokens") ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function tokenCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Error thrown for a price table that exists but cannot be parsed. */
export class PriceTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceTableError";
  }
}

/** USD per 1k tokens for one model. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

/**
 * A price-table entry as accepted by {@link createPriceTable}: a decimal rate
 * (string or number) applied to prompt and completion alike, or a split
 * `{ prompt, completion }` (a missing side falls back to the other side).
 */
export type PriceEntryInput = number | string | {
  prompt?: number | string;
  completion?: number | string;
};

/** Per-model rates plus the pricing of a {@link Usage} into `costUsd`. */
export interface PriceTable {
  /** USD per 1k tokens; `{ prompt: 0, completion: 0 }` for an absent model. */
  priceFor(model: string): ModelPrice;
  /** Exact USD cost of `usage` on `model`; `0` for an absent model. */
  costUsd(model: string, usage: Usage): number;
}

const MICRO_USD = 1_000_000;
const MAX_FRACTION_DIGITS = 6;

/** Rates held internally as integer micro-USD per 1k tokens. */
interface MicroRates {
  prompt: number;
  completion: number;
}

/**
 * Build a price table from a model→rate mapping (see {@link PriceEntryInput}).
 * Decimal *strings* keep exact precision; numbers are rounded to micro-USD.
 */
export function createPriceTable(entries: Record<string, PriceEntryInput>): PriceTable {
  const rates = new Map<string, MicroRates>();
  for (const [model, entry] of Object.entries(entries)) {
    rates.set(model, microRates(entry, `price table entry "${model}"`));
  }
  return {
    priceFor(model: string): ModelPrice {
      const modelRates = rates.get(model);
      return modelRates
        ? { prompt: modelRates.prompt / MICRO_USD, completion: modelRates.completion / MICRO_USD }
        : { prompt: 0, completion: 0 };
    },
    costUsd(model: string, usage: Usage): number {
      const modelRates = rates.get(model);
      if (!modelRates) {
        return 0;
      }
      const nanoUsd = usage.promptTokens * modelRates.prompt + usage.completionTokens * modelRates.completion;
      return nanoUsd / 1e9;
    },
  };
}

function microRates(entry: PriceEntryInput, context: string): MicroRates {
  if (typeof entry === "object" && entry !== null) {
    const prompt = parseMicroUsd(entry.prompt, `${context} (prompt)`);
    // A missing side falls back to the parsed prompt rate (already micro-USD).
    const completion =
      entry.completion === undefined ? prompt : parseMicroUsd(entry.completion, `${context} (completion)`);
    return { prompt, completion };
  }
  const rate = parseMicroUsd(entry, context);
  return { prompt: rate, completion: rate };
}

/**
 * Parse one rate into integer micro-USD. Strings are matched as
 * `/^\d+(\.\d{1,6})?$/` and converted digit-exactly (no float rounding);
 * numbers are validated non-negative/finite and rounded to the nearest micro.
 */
function parseMicroUsd(value: number | string | undefined, context: string): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new PriceTableError(`${context} must be a non-negative number, got ${value}`);
    }
    return Math.round(value * MICRO_USD);
  }
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) {
    throw new PriceTableError(
      `${context} must be a non-negative decimal with at most ${MAX_FRACTION_DIGITS} fraction digits (USD per 1k tokens), got "${text}"`,
    );
  }
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * MICRO_USD + Number(fraction.padEnd(MAX_FRACTION_DIGITS, "0"));
}

/**
 * Absolute path of the shipped price table, `product/identity/price-table.yaml`
 * at the workspace root. The root is found by walking up from this module to
 * the directory holding `pnpm-workspace.yaml`, so resolution works from any
 * cwd; without a marker the nearest ancestor path is returned and the loader
 * treats the missing file as an empty table.
 */
export function defaultPriceTablePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  let root = dir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      root = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return join(root, "product", "identity", "price-table.yaml");
}

/**
 * Load the price table from `filePath` (default: the shipped table, see
 * {@link defaultPriceTablePath}). The table is optional: a missing file
 * (ENOENT) yields an empty table that prices every model at $0. A file that
 * exists but violates the format throws {@link PriceTableError}.
 */
export function loadPriceTable(filePath: string = defaultPriceTablePath()): PriceTable {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return createPriceTable({});
    }
    throw new PriceTableError(`cannot read price table at ${filePath}: ${code ?? String(error)}`);
  }
  return parsePriceTableYaml(text, filePath);
}

/**
 * Parse the price-table YAML subset: `model: <decimal>` at indent 0, or a
 * `model:` block with indented `prompt:`/`completion:` rates. Blank lines and
 * `#` comments are ignored; tabs and other shapes are rejected with the
 * offending line number.
 */
export function parsePriceTableYaml(text: string, source = "price table"): PriceTable {
  const entries: Record<string, PriceEntryInput> = {};
  let openModel: string | undefined;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const where = `${source}, line ${index + 1}`;
    if (rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const line = rawLine.replace(/\s+#.*$/, "");
    if (line.trim() === "") {
      continue;
    }
    if (line.startsWith("\t") || /^\s*\t/.test(rawLine)) {
      throw new PriceTableError(`${where}: tabs are not valid indentation; use spaces`);
    }
    const indent = line.length - line.trimStart().length;
    const match = /^([\w./-]+):(?:\s+(.*))?$/.exec(line.trim());
    if (!match) {
      throw new PriceTableError(`${where}: expected "\`<model>:\`" or "\`prompt:/completion:\`" with a decimal rate`);
    }
    const [, key = "", value = ""] = match;
    if (indent === 0) {
      if (value === "") {
        entries[key] = {};
        openModel = key;
      } else {
        parseMicroUsd(value, where); // validate here so errors carry file + line
        entries[key] = value;
        openModel = undefined;
      }
      continue;
    }
    if (openModel === undefined) {
      throw new PriceTableError(`${where}: indented line outside any model block`);
    }
    if (key !== "prompt" && key !== "completion") {
      throw new PriceTableError(`${where}: expected "prompt" or "completion" inside model "${openModel}", got "${key}"`);
    }
    if (value === "") {
      throw new PriceTableError(`${where}: "${key}:" needs a decimal rate (USD per 1k tokens)`);
    }
    parseMicroUsd(value, where); // validate here so errors carry file + line
    const block = entries[openModel];
    if (typeof block === "object" && block !== null) {
      entries[openModel] = { ...block, [key]: value };
    }
  }
  return createPriceTable(entries);
}

let cachedDefaultTable: PriceTable | undefined;

/** The shared price table, lazily loaded once from the shipped YAML. */
export function defaultPriceTable(): PriceTable {
  return (cachedDefaultTable ??= loadPriceTable());
}

/** How many events the default metering log keeps (the HUD window). */
export const DEFAULT_RING_CAPACITY = 100;

/** Anything that can receive {@link MeteringEvent}s. */
export interface MeteringSink {
  emit(event: MeteringEvent): void;
}

/** Callback fired for every emitted event (the cost HUD attaches one). */
export type MeteringListener = (event: MeteringEvent) => void;

/**
 * The default sink: a ring buffer of the last `capacity` events plus
 * subscriptions. `recent()` returns a fresh array ordered oldest → newest;
 * listeners fire synchronously on emit, and one listener throwing never
 * breaks the emit or the other listeners.
 */
export interface MeteringLog extends MeteringSink {
  readonly capacity: number;
  recent(): MeteringEvent[];
  subscribe(listener: MeteringListener): () => void;
}

/** Create a {@link MeteringLog} ring buffer (default capacity 100). */
export function createMeteringLog(capacity: number = DEFAULT_RING_CAPACITY): MeteringLog {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`metering log capacity must be a positive integer, got ${capacity}`);
  }
  const ring = Array.from<MeteringEvent | undefined>({ length: capacity });
  const listeners = new Set<MeteringListener>();
  let next = 0;
  let size = 0;
  return {
    capacity,
    emit(event: MeteringEvent): void {
      ring[next] = event;
      next = (next + 1) % capacity;
      size = Math.min(size + 1, capacity);
      // Snapshot so a listener that (un)subscribes mid-emit cannot corrupt the loop.
      const snapshot = [...listeners];
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch {
          // One misbehaving subscriber must not break the response path.
        }
      }
    },
    recent(): MeteringEvent[] {
      const events: MeteringEvent[] = [];
      const oldest = (next - size + capacity) % capacity;
      for (let offset = 0; offset < size; offset++) {
        const event = ring[(oldest + offset) % capacity];
        if (event !== undefined) {
          events.push(event);
        }
      }
      return events;
    },
    subscribe(listener: MeteringListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let defaultLog: MeteringLog | undefined;

/** The shared metering log: ring of the last 100 events, subscribe for live. */
export function defaultMeteringLog(): MeteringLog {
  return (defaultLog ??= createMeteringLog());
}
