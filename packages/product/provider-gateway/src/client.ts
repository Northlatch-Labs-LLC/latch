/**
 * Latch gateway client — OpenAI-compatible HTTP surface.
 *
 * Header contract (single owner: {@link authHeaders}):
 * - Every request to `{base}/v1/*` carries
 *   `Authorization: Bearer <LATCH_API_KEY>`.
 * - `chatCompletion` additionally carries `Content-Type: application/json`.
 * - When `LATCH_API_KEY` is unset the Authorization header is omitted and the
 *   gateway answers 401, which the client maps to `GatewayAuthError`.
 */
import type { GatewayConfig } from "./config.js";
import { GatewayAuthError, GatewayHttpError } from "./errors.js";
import {
  ZERO_USAGE,
  defaultMeteringLog,
  defaultPriceTable,
  parseUsage,
  type MeteringEvent,
  type MeteringSink,
  type PriceTable,
  type Usage,
} from "./metering.js";

/** One entry of the `/v1/models` catalog. */
export interface GatewayModel {
  id: string;
  object?: string;
  owned_by?: string;
}

/** Response of `GET {base}/v1/models`. */
export interface ListModelsResponse {
  object?: string;
  data: GatewayModel[];
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Request body of `POST {base}/v1/chat/completions`. OpenAI-compatible; the
 * index signature lets callers forward gateway-supported extras (tools,
 * stream, ...) without this package enumerating them.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatChoice {
  index?: number;
  message: ChatMessage;
  finish_reason?: string;
}

/** Response of `POST {base}/v1/chat/completions`. */
export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices: ChatChoice[];
  usage?: Record<string, unknown>;
}

/** Authorization header required by the gateway on every `/v1/*` request. */
export function authHeaders(config: GatewayConfig): Record<string, string> {
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}

/** `GET {base}/v1/models` — list the models offered by the gateway. */
export async function listModels(config: GatewayConfig): Promise<ListModelsResponse> {
  const response = await fetch(`${config.baseUrl}/v1/models`, {
    method: "GET",
    headers: authHeaders(config),
  });
  return parseJsonResponse<ListModelsResponse>("/v1/models", response);
}

/** Result of `POST {base}/v1/chat/completions` with usage accounting. */
export interface ChatCompletionResult {
  /** First choice's message content; `""` when the gateway sent no choices. */
  content: string;
  /** Parsed `usage` object, or `undefined` when the response carried none. */
  usage: Usage | undefined;
  /** The metering event also emitted to the sink (see ChatCompletionOptions). */
  metering: MeteringEvent;
}

/** Injection points for `chatCompletion` metering. */
export interface ChatCompletionOptions {
  /** Metering sink; defaults to the shared ring buffer (see defaultMeteringLog). */
  sink?: MeteringSink;
  /** Price table pricing `costUsd`; defaults to the shipped price-table.yaml. */
  priceTable?: PriceTable;
}

/**
 * `POST {base}/v1/chat/completions` — run a chat completion, metered.
 *
 * On a 2xx response the usage object is parsed and a {@link MeteringEvent} is
 * emitted synchronously to `options.sink` (default: the shared in-memory log)
 * before the result resolves. A response without a valid `usage` still emits —
 * with zero tokens and $0 cost — so the cost HUD sees every completion. A
 * non-2xx response throws from {@link GatewayHttpError} mapping and emits
 * nothing.
 */
export async function chatCompletion(
  config: GatewayConfig,
  request: ChatCompletionRequest,
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const parsed = await parseJsonResponse<ChatCompletionResponse>("/v1/chat/completions", response);
  const usage = parseUsage(parsed.usage);
  const model = parsed.model ?? request.model;
  const metering: MeteringEvent = {
    model,
    ...(usage ?? ZERO_USAGE),
    costUsd: usage ? (options.priceTable ?? defaultPriceTable()).costUsd(model, usage) : 0,
    requestId: parsed.id ?? "",
    timestamp: new Date().toISOString(),
  };
  (options.sink ?? defaultMeteringLog()).emit(metering);
  return {
    content: parsed.choices[0]?.message.content ?? "",
    usage,
    metering,
  };
}

const MAX_ERROR_BODY_CHARS = 200;

function errorBodySnippet(body: string): string {
  return body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…` : body;
}

async function parseJsonResponse<T>(path: string, response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const message = `Gateway request to ${path} failed with status ${response.status}: ${errorBodySnippet(text)}`;
    if (response.status === 401 || response.status === 403) {
      throw new GatewayAuthError(message, response.status, text);
    }
    throw new GatewayHttpError(message, response.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayHttpError(
      `Gateway request to ${path} returned status ${response.status} with a non-JSON body: ${errorBodySnippet(text)}`,
      response.status,
      text,
    );
  }
}
