# Phone access to local threads

Threads that run on your own computer can be followed and answered from the web dashboard
on your phone, when you choose to. It is **off by default**, set **per computer** in the
desktop app (Settings → General → Phone), and turning it off cuts every phone session at once.

## How it fits together

```
phone (dashboard) ──wss──▶ control plane: phone bridge ◀──wss── desktop app ──ws (loopback)──▶ runner
        │                         ▲                                  │
        └──HTTPS (ticket)──▶ control plane ◀──HTTPS (register, link ticket)┘
```

- While phone access is on, the desktop app registers the computer (`PUT /api/computers/:id`)
  with a short list of its threads (title, agent, repository **folder name**, branch,
  status, times; never paths, commands or history) and keeps one outbound WebSocket, the
  **link**, to the bridge (`/api/phone/link/:computerId`). Local runners still listen on
  loopback only.
- The dashboard lists those threads under the computer's name: live while the computer is
  linked, otherwise "Your Mac is offline" with the last known state. Opening one asks
  `GET /api/computers/:id/threads/:threadId` for an endpoint, as cloud threads do.
- The phone then opens `/api/phone/ws/:computerId/:threadId` and speaks the ordinary
  runner protocol with the ordinary `RunnerClient`; only the URL is different. The bridge
  pipes its frames over the link; the desktop app pipes them to the thread's runner.

## Who can reach what

Every step checks again; none trusts the one before.

1. **Control plane routes** (`apps/web/src/lib/computers.ts`, through `access.ts`): a
   computer belongs to one user. Only that user, while still a member of the workspace the
   computer is registered in, can list it, get a link ticket or get a phone endpoint, and
   only for a thread the computer shares. Everyone else gets "not found".
2. **Tickets.** The control plane signs short-lived tickets with a key derived from its
   master secret (`deriveBridgeKey`): a link ticket (computer, user) and a phone ticket
   (computer, thread, user), 15 minutes each, carrying the computer's **epoch**. The
   epoch goes up every time phone access is turned off, so tickets handed out before then
   stop working even if phone access is turned on again. The bridge checks the ticket in
   the first frame (never in the URL), and that the phone's ticket matches the linked
   computer's user and epoch. It never reads the database.
3. **The desktop app** answers a phone only for a thread it has (not archived), and opens
   the runner with a **`phone` token it signs itself** for that thread and user, no
   longer-lived than the phone's ticket. It rebuilds the phone's hello, so nothing from the
   phone reaches the runner as a token. **The thread secret never leaves the computer**, and
   the control plane can't sign anything a runner accepts.
4. **The runner** checks the phone token like any other (signature, thread, expiry, lifetime
   cap) and closes the connection when it runs out (`closeAtExpiry`, code 4001; the
   dashboard reconnects with a fresh ticket). A `phone` token gets fewer powers than a
   `client` token:
   - no computer access (`computer_request`s never reach it, `computer_result` is refused);
   - no agent sign-in (no `login` updates, `start_login`/`login_input` refused);
   - it can't give the agent **full access** (other permission modes are fine);
   - only the thread WebSocket: the terminal, previews, file lists, uploads, downloads,
     git review and teleport all still need a `client` token.

   It can follow the thread, send and edit messages, interrupt, answer questions and
   approve or decline what the agent asks, which is the point of the feature.

Turning phone access off in the desktop app closes the link and every runner socket
opened for a phone right away, on the computer. Then the control plane bumps the epoch,
forgets the shared threads and tells the bridge to close anything left (code 4403). If the
control plane can't be reached at that moment, the app tells it on its next start; the
phones are already cut, because they only ever reach the computer through the link.

## Limits

| What | Limit |
| --- | --- |
| Frame from a phone | 256 KiB (bigger closes it, code 1009) |
| Frame on the link (an event from the runner, wrapped) | 4 MiB; a bigger one ends that phone's session |
| Phones per thread / per computer | 3 / 12 (code 4429 beyond) |
| Phone idle (no frames either way) | 5 minutes (code 4408; the dashboard reconnects) |
| Link silent (the app pings every 30 s) | 90 seconds |
| First frame after connecting | 10 seconds |
| Tickets | 15 minutes; the app renews its link ticket on the open link |

## Running the bridge

**Cloudflare Workers.** `worker.ts` exports the `PhoneBridge` Durable Object (one per
computer) and sends `/api/phone/…` WebSockets to it. It uses the WebSocket hibernation API
and answers the app's pings without waking. `apps/web/wrangler.jsonc` has the binding:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "PHONE_BRIDGE", "class_name": "PhoneBridge" }],
},
"migrations": [{ "tag": "v1-phone-bridge", "new_sqlite_classes": ["PhoneBridge"] }],
```

Without the `PHONE_BRIDGE` binding, phone access reports itself as unavailable in the
desktop app and the bridge paths answer 503; nothing else changes.

**Node.** `next start` and `next dev` can't take WebSockets, so start the control plane with
`apps/web/server.ts` instead (Node 22.18 or newer): `pnpm --filter @lemonlime/web serve`
after `next build`, or `dev:serve` while developing. It is `next start` plus an in-process
hub. The Docker image runs it. Under plain `next start` phone access is unavailable. The
in-process hub serves one Node process; run one replica, or use Workers.
