import { randomUUID } from "node:crypto";
import type { ComputerRequest, ServerMessage } from "@lemonlime/protocol";

/** Long enough for a person to read an "Ask first" question and answer it. */
const ANSWER_TIMEOUT_MS = 6 * 60_000;

export type ComputerAnswer = { ok: boolean; output: string };

/**
 * Computer access for cloud agents: requests go to the newest connected desktop app that
 * said it can answer, which decides by the user's setting and replies once. With no such
 * app open, the agent is told so.
 */
export class ComputerBridge {
  private clients: ((m: ServerMessage) => void)[] = [];
  private waiting = new Map<string, (a: ComputerAnswer) => void>();

  addClient(send: (m: ServerMessage) => void): () => void {
    this.clients.push(send);
    return () => {
      this.clients = this.clients.filter(c => c !== send);
    };
  }

  get available(): boolean {
    return this.clients.length > 0;
  }

  request(request: ComputerRequest, timeoutMs = ANSWER_TIMEOUT_MS): Promise<ComputerAnswer> {
    const send = this.clients.at(-1);
    if (!send) return Promise.resolve({ ok: false, output: "The user's LemonLime desktop app isn't open, so their computer can't be reached right now." });
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve({ ok: false, output: "No answer from the user's computer in time." });
      }, timeoutMs);
      this.waiting.set(requestId, a => {
        clearTimeout(timer);
        resolve(a);
      });
      send({ type: "computer_request", requestId, request });
    });
  }

  /** An answer from a desktop app. Unknown or repeated ids are ignored. */
  answer(requestId: string, a: ComputerAnswer): void {
    const finish = this.waiting.get(requestId);
    if (!finish) return;
    this.waiting.delete(requestId);
    finish(a);
  }
}
