import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRequest {
  /** The agent's own name for the tool, e.g. "Bash". */
  tool: string;
  input: unknown;
  /** One line saying what will happen, e.g. the exact command. */
  summary: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * A private HTTP endpoint on 127.0.0.1 that an agent-side helper (the approval MCP
 * server Claude Code runs) calls to ask the user for permission. Only callers holding
 * the random token are answered.
 */
export class ApprovalBridge {
  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly token: string,
  ) {}

  static start(ask: (req: ApprovalRequest) => Promise<ApprovalDecision>): Promise<ApprovalBridge> {
    const token = randomBytes(32).toString("hex");
    const expected = Buffer.from(`Bearer ${token}`);
    const server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const auth = Buffer.from(req.headers.authorization ?? "");
      if (req.method !== "POST" || req.url !== "/approve" || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        return reply(404, { error: "not_found" });
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        let body: Partial<ApprovalRequest>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ApprovalRequest>;
        } catch {
          return reply(400, { error: "bad_request" });
        }
        if (typeof body.tool !== "string") return reply(400, { error: "bad_request" });
        const request: ApprovalRequest = { tool: body.tool, input: body.input ?? null, summary: typeof body.summary === "string" ? body.summary : body.tool };
        ask(request).then(
          decision => reply(200, { decision }),
          () => reply(200, { decision: "deny" }),
        );
      });
    });
    // Approvals can wait a long time for the user; never time the request out here.
    server.requestTimeout = 0;
    server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(new ApprovalBridge(server, `http://127.0.0.1:${port}/approve`, token));
      });
    });
  }

  close(): Promise<void> {
    return new Promise(done => {
      this.server.closeAllConnections?.();
      this.server.close(() => done());
    });
  }
}

/** One readable line for a tool call: the command, the file, or the tool name. */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "file_path", "filePath", "path", "url", "pattern", "query"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v;
      if (Array.isArray(v) && v.length && v.every(x => typeof x === "string")) return v.join(" ");
    }
  }
  if (typeof input === "string" && input.trim()) return input;
  return tool;
}
