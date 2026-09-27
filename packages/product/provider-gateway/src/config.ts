/**
 * Latch gateway configuration, read from the process environment.
 *
 * Environment contract:
 * - `LATCH_GATEWAY_URL`: gateway base URL. Defaults to the canonical
 *   `gateway_base_url` from `product/identity/brand.yaml`
 *   (https://gateway.xlaunch.work).
 * - `LATCH_API_KEY`: bearer credential sent as `Authorization: Bearer <key>`
 *   on every gateway request (see README "Header contract").
 */

/** Canonical gateway base URL; mirrors `product/identity/brand.yaml`. */
export const DEFAULT_GATEWAY_BASE_URL = "https://gateway.xlaunch.work";

export interface GatewayConfig {
  /** Base URL without a trailing slash, e.g. `https://gateway.xlaunch.work`. */
  baseUrl: string;
  /** Bearer credential, or `undefined` when `LATCH_API_KEY` is unset/empty. */
  apiKey: string | undefined;
}

/** The subset of the environment this package reads. */
export interface GatewayEnv {
  LATCH_GATEWAY_URL?: string | undefined;
  LATCH_API_KEY?: string | undefined;
}

/**
 * Read the gateway configuration from `env` (defaults to `process.env`).
 *
 * An unset or empty `LATCH_GATEWAY_URL` falls back to
 * {@link DEFAULT_GATEWAY_BASE_URL}; trailing slashes are stripped so request
 * paths join as `{base}/v1/...`. An unset or empty `LATCH_API_KEY` yields
 * `undefined` — requests then go out without an Authorization header and the
 * gateway answers 401 (mapped to `GatewayAuthError` by the client).
 */
export function readConfig(env: GatewayEnv = process.env): GatewayConfig {
  const baseUrl = (env.LATCH_GATEWAY_URL || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const apiKey = env.LATCH_API_KEY || undefined;
  return { baseUrl, apiKey };
}
