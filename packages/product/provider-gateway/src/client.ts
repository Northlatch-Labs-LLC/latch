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

/** `POST {base}/v1/chat/completions` — run a chat completion. */
export async function chatCompletion(
  config: GatewayConfig,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseJsonResponse<ChatCompletionResponse>("/v1/chat/completions", response);
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
