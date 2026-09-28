/**
 * Errors thrown by the Latch gateway client for non-2xx gateway responses.
 */

export class GatewayHttpError extends Error {
  /** HTTP status returned by the gateway. */
  readonly status: number;
  /** Raw response body, untruncated (the error message carries a snippet). */
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Authentication/authorization failure (HTTP 401 or 403), e.g. a missing or
 * invalid `Authorization: Bearer <LATCH_API_KEY>` credential.
 */
export class GatewayAuthError extends GatewayHttpError {
  constructor(message: string, status: number, body: string) {
    super(message, status, body);
    this.name = "GatewayAuthError";
  }
}

/**
 * Spend-cap refusal (HTTP 402) — the gateway enforced a cap server-side
 * (INV-5). `code` distinguishes `per_call_ceiling_exceeded` from
 * `session_cap_exceeded`; `retryable` is false for per-call ceilings (a
 * smaller request may pass) and stated by the gateway for session caps.
 */
export class GatewayCapError extends GatewayHttpError {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, body: string, code: string, retryable: boolean) {
    super(message, status, body);
    this.name = "GatewayCapError";
    this.code = code;
    this.retryable = retryable;
  }
}
