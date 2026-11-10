import type { Readable } from "node:stream";

/** A thread secret is 64 hex characters; anything this long on the first line is not one. */
export const SECRET_LINE_MAX = 4096;

/**
 * `--secret-stdin`: the thread secret is the first line on stdin. An app that starts the
 * runner on another machine (over SSH) sends it this way, so it never appears on a command
 * line (where `ps` would show it) or in the environment of the remote shell.
 *
 * Only that line is read. The stream is paused straight after it; `releaseStdin` decides
 * what happens to the rest.
 */
export function readSecretLine(input: Readable, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (err: Error | null, secret = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      // The other end going away later is for `releaseStdin` to notice, never a crash.
      input.on("error", () => {});
      input.pause();
      if (err) reject(err);
      else resolve(secret);
    };
    const onData = (chunk: Buffer | string) => {
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const nl = buf.indexOf(10);
      if (nl >= 0) return finish(null, buf.subarray(0, nl).toString("utf8").trim());
      if (buf.length > SECRET_LINE_MAX) finish(new Error("the first line on stdin is too long to be a thread secret"));
    };
    const onEnd = () => (buf.length > 0 ? finish(null, buf.toString("utf8").trim()) : finish(new Error("stdin closed before the thread secret arrived")));
    const onError = (err: Error) => finish(new Error(`couldn't read the thread secret from stdin: ${err.message}`));
    const timer = setTimeout(() => finish(new Error("no thread secret arrived on stdin")), timeoutMs);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * After the secret, stdin is never read for anything else. Without `onClose` it is closed
 * at once. With it (the app asked the runner to stop with it), whatever else arrives is
 * thrown away unread, and stdin closing, which is how an SSH session ending shows on the
 * remote machine, calls `onClose` once.
 */
export function releaseStdin(input: Readable, onClose?: () => void): void {
  if (!onClose) {
    input.destroy();
    return;
  }
  let called = false;
  const closed = () => {
    if (called) return;
    called = true;
    onClose();
  };
  if (input.readableEnded || input.destroyed) return closed();
  input.on("data", () => {});
  input.once("end", closed);
  input.once("close", closed);
  input.once("error", closed);
  input.resume();
}
