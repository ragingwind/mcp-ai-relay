import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
  rawBody: string;
}

export interface MockResponse {
  status: number;
  body: string;
  delayMs?: number;
  hang?: boolean;
}

export interface MockOpenAI {
  url: string;
  baseURL: string;
  requests: RecordedRequest[];
  setResponse(handler: (req: RecordedRequest) => MockResponse): void;
  close(): Promise<void>;
}

export function defaultSseBody(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

export async function startMockOpenAI(): Promise<MockOpenAI> {
  const recorded: RecordedRequest[] = [];
  let responder: (req: RecordedRequest) => MockResponse = () => ({
    status: 200,
    body: defaultSseBody("ok"),
  });

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const recordedReq: RecordedRequest = {
        authorization: req.headers.authorization,
        body,
        rawBody: text,
      };
      recorded.push(recordedReq);
      const out = responder(recordedReq);

      const send = () => {
        if (out.hang) return;
        res.statusCode = out.status;
        if (out.status === 200) {
          res.setHeader("content-type", "text/event-stream");
        } else {
          res.setHeader("content-type", "application/json");
        }
        res.end(out.body);
      };

      if (out.delayMs && out.delayMs > 0) {
        setTimeout(send, out.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    baseURL: `${url}/v1`,
    requests: recorded,
    setResponse(h) {
      responder = h;
    },
    async close() {
      httpServer.closeAllConnections?.();
      await new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r())));
    },
  };
}
