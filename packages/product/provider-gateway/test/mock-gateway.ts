import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
}

export type MockHandler = (
  request: CapturedRequest,
  respond: (status: number, body: unknown) => void,
) => void;

export interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * Local node:http mock gateway. Listens on an ephemeral 127.0.0.1 port so the
 * client under test exercises real fetch + header serialization.
 */
export function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      handler(captured, (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      // undici keeps the socket pooled; destroy it so close() does not hang.
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, requests, close });
    });
  });
}

/** A chat completion body the mock gateway can serve verbatim. */
export function chatCompletionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "latch-large",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "pong" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 },
    ...overrides,
  };
}
