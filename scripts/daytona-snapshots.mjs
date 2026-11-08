// Makes one Daytona snapshot per sandbox size from the sandbox image, so cloud threads
// start from a ready snapshot instead of building the image each time.
//
//   node scripts/daytona-snapshots.mjs
//
// Reads DAYTONA_API_KEY from the environment, or asks for it without echoing it.
// Optional: DAYTONA_API_URL, LEMONLIME_SANDBOX_IMAGE (the image to snapshot).
// Prints the DAYTONA_SNAPSHOT_SMALL / DAYTONA_SNAPSHOT_LARGE values to set.
import { stdin, stdout } from "node:process";

// Keep in step with SANDBOX_RESOURCES in packages/protocol/src/thread.ts.
const SIZES = {
  small: { cpu: 1, memory: 2, disk: 10 },
  large: { cpu: 2, memory: 4, disk: 10 },
};
const apiUrl = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
const image = process.env.LEMONLIME_SANDBOX_IMAGE || "ghcr.io/hamedgitty/lemonlime-sandbox:latest";

function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) return reject(new Error("Set DAYTONA_API_KEY, or run this in a terminal to type it."));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = ch => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value.trim());
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const apiKey = process.env.DAYTONA_API_KEY || (await askHidden("Daytona API key (hidden): "));
if (!apiKey) throw new Error("No Daytona API key given.");

async function api(method, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Daytona ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const made = {};
for (const [size, r] of Object.entries(SIZES)) {
  const name = `lemonlime-${size}-${stamp}`;
  console.log(`Creating ${name} from ${image} (${r.cpu} CPU, ${r.memory} GB memory, ${r.disk} GB disk)`);
  const snap = await api("POST", "/snapshots", { name, imageName: image, cpu: r.cpu, memory: r.memory, disk: r.disk });
  const started = Date.now();
  let state = snap.state;
  while (state !== "active") {
    if (state === "error" || state === "build_failed") {
      const s = await api("GET", `/snapshots/${encodeURIComponent(snap.id)}`);
      throw new Error(`Snapshot ${name} failed: ${s.errorReason || state}`);
    }
    if (Date.now() - started > 20 * 60 * 1000) throw new Error(`Snapshot ${name} is still ${state} after 20 minutes; check the Daytona dashboard.`);
    await new Promise(r => setTimeout(r, 5000));
    state = (await api("GET", `/snapshots/${encodeURIComponent(snap.id)}`)).state;
    stdout.write(`  ${state}\r`);
  }
  console.log(`\r  ${name} is ready.          `);
  made[size] = name;
}

console.log("\nSet these on the control plane, then new cloud threads start from the snapshots:\n");
console.log(`DAYTONA_SNAPSHOT_SMALL=${made.small}`);
console.log(`DAYTONA_SNAPSHOT_LARGE=${made.large}`);
