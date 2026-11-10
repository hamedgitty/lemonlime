# Phone access to local threads

Threads that run on your own computer can be followed and answered from the web dashboard
on your phone, when you choose to. It is **off by default**, set **per computer** in the
desktop app (Settings → General → Phone), and turning it off cuts every phone session at once.

A phone has to be **paired** with the computer first, by scanning a code the desktop app
shows. Pairing gives the phone's browser a key the control plane never sees, and everything
the phone and the computer say to each other is sealed with it. The control plane carries
the conversation without being able to read it or add to it.

## How it fits together

```
phone (dashboard) ──wss──▶ control plane: phone bridge ◀──wss── desktop app ──ws (loopback)──▶ runner
        │                         ▲                                  │
        └──HTTPS (ticket)──▶ control plane ◀──HTTPS (register, link ticket)┘

phone ◀═══════ sealed with the pairing key, end to end ═══════▶ desktop app
```

- While phone access is on, the desktop app registers the computer (`PUT /api/computers/:id`)
  with a short list of its threads (title, agent, repository **folder name**, branch,
  status, times; never paths, commands or history) and keeps one outbound WebSocket, the
  **link**, to the bridge (`/api/phone/link/:computerId`). Local runners still listen on
  loopback only.
- The dashboard lists those threads under the computer's name: live while the computer is
  linked, otherwise "Your Mac is offline" with the last known state. Opening one asks
  `GET /api/computers/:id/threads/:threadId` for an endpoint, as cloud threads do.
- The phone then opens `/api/phone/ws/:computerId/:threadId`. The dashboard uses the
  ordinary `RunnerClient` over a WebSocket that seals what it sends and opens what it gets
  (`sealedWebSocket` in `packages/client`). The bridge pipes the sealed frames over the
  link; the desktop app opens them and pipes what was inside to the thread's runner.

## Pairing

The desktop app makes a **pairing key** for the computer: 32 random bytes, kept in the
operating system's keychain next to the app's sign-in, never in its settings. If the
keychain can't hold it, the key lasts until the app quits and the app says so.

"Pair a phone" shows the key as a QR code and a link:

```
<control plane URL>/phone/pair#v1.<computer id>.<key, base64url>
```

Everything after the `#` is the address's fragment, which a browser never sends to a
server. The page at `/phone/pair` runs in the phone's browser. It keeps the key in the
browser's local storage under the computer's id and takes the fragment out of the address
bar at once. It never puts the key in a request or a link. It works signed out (the key is
kept first, then it offers sign-in), sets a `no-referrer` policy, and refuses a link that
is incomplete or was changed.

- **One key per computer.** Every paired phone holds the same key.
- **Unpair all phones** makes a new key. Sessions sealed with the old one end at once, and
  every phone has to scan the new code.
- **Signing out of the desktop app** turns phone access off and makes a new key too, so
  whoever signs in next starts with no phone paired.
- **Pairing belongs to one browser at one dashboard address.** Another browser on the same
  phone, a private window, or the same dashboard under another address is not paired.
  Clearing the browser's data for the dashboard unpairs it.
- The code is only on screen while you ask for it, and is gone when Settings closes.

## Sealed sessions

The bridge still checks the phone's ticket in the first frame, as before. What follows,
inside the frames it pipes, is between the phone and the computer:

```
phone    → {"type":"hello","token":"<ticket>"}            for the bridge, in the clear
phone    → {"type":"e2e_hello","v":1,"nonce":"<16 random bytes, base64url>"}
computer → {"type":"e2e_hello","v":1,"nonce":"<16 random bytes, base64url>"}
both, from then on → {"type":"e2e","n":<counter>,"c":"<sealed bytes, base64url>"}
```

- Both ends derive two AES-256-GCM keys, one for each direction, with HKDF-SHA256 from the
  pairing key. The salt is both nonces; the derivation is also bound to a version label,
  the computer's id, the thread's id and the direction. So a frame only opens in the
  session, the thread and the direction it was sealed for, by someone who holds the key.
- A direction's counter starts at 0 and every frame must carry exactly the next number. The
  counter is the frame's IV and is authenticated along with the direction. A frame that was
  replayed, moved, renumbered or changed doesn't open.
- A message longer than 128 KiB travels as several frames. A byte under the seal says
  whether more follows, so a message can't be cut short unnoticed.
- **The desktop app starts nothing for a phone until the phone's first sealed frame has
  opened.** Before that it doesn't start the thread's runner, doesn't connect to it and
  sends nothing but its own nonce. The phone's real hello (where to resume from) is the
  first sealed frame.
- Any frame that isn't sealed, isn't the next one or doesn't open **ends the session at
  once**, on whichever end sees it. The desktop app closes the phone with code 4412 and the
  reason "Pair this phone with your computer"; the dashboard shows that, and stops retrying.
- The dashboard never forgets its key because a connection was refused. A refusal can be
  made up by whoever carries the frames, and a browser that gave up its key could then be
  offered an open connection instead.

The desktop app tells the control plane that it seals (`sealed: true` when it registers),
and the control plane passes that to the dashboard. That flag only decides what the
dashboard shows:

| The computer says it seals | This browser has its key | What the dashboard does |
| --- | --- | --- |
| yes | yes | connects, sealed |
| yes | no | doesn't connect; explains how to pair |
| no (an older desktop app) | no | connects the way it always did, and suggests updating the app |
| no | yes | connects sealed and accepts nothing else |

Once a browser holds a key for a computer it insists on sealing whatever the control plane
says, so the control plane can't talk it down. And the desktop app has no setting to turn
sealing off: it turns away every session that doesn't seal.

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
3. **Pairing.** A ticket gets a phone as far as the desktop app and no further. The app
   answers only a phone that proves it holds the pairing key, by sealing a frame with it
   (see above). The control plane signs the tickets; it can't make that proof.
4. **The desktop app** answers a paired phone only for a thread it has (not archived), and
   opens the runner with a **`phone` token it signs itself** for that thread and user, no
   longer-lived than the phone's ticket. It rebuilds the phone's hello, so nothing from the
   phone reaches the runner as a token. **The thread secret never leaves the computer**, and
   the control plane can't sign anything a runner accepts.
5. **The runner** checks the phone token like any other (signature, thread, expiry, lifetime
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

## What you are trusting

**The control plane can no longer read a session or take part in one.** It carries sealed
frames. Without the pairing key it can't open them, can't write one the computer or the
phone accepts, and can't replay, reorder or alter one without that session ending. A ticket
it signs for itself gets it nothing from the computer, because the desktop app starts
nothing for a phone that hasn't proved it is paired.

**What it can still see and do:**

- It sees the list each computer shares for the dashboard: thread titles, agent,
  repository folder name, branch, status and times. Those are registered in the clear.
- It sees who connects to which computer and thread, when, for how long, and how many
  frames of what size go each way.
- It can drop or delay frames, close sessions, and refuse to carry anything at all.
  Dropping a frame ends the session; it doesn't change what either end reads.
- It still says which signed-in user a session belongs to and when its ticket runs out.
  The desktop app takes its word for those two, once the phone has proved it is paired.

**The pairing code is a key.** Whoever has it, and can also get a ticket (by signing in as
you, or by controlling the control plane), can drive the threads the computer shares, with
the limited powers listed above. So can anyone holding a paired phone that is unlocked and
signed in. Don't send the link through anything you wouldn't trust with a password, and
use "Unpair all phones" if a phone is lost or the link may have been seen.

**Unpairing protects what comes next, not what was already sent.** A new key cuts every
phone off from then on. A session's keys are made from the pairing key and the two nonces,
which travel in the clear, so someone who recorded sealed sessions and later gets the old
key could read those recordings.

**The dashboard's own code is still served by the control plane.** The key sits in the
browser's local storage, where the dashboard's JavaScript reads it to seal the session. A
control plane that served changed JavaScript could take the key from there, or copy what
the page shows. Sealing protects against a control plane (or anything in front of it) that
reads or alters traffic. It does not protect against one that serves malicious code to
your browser. That is the trust that remains. Running the control plane yourself removes
it, and so would a phone app that doesn't load its code from the control plane.

## Older versions

- **An older desktop app** doesn't pair and doesn't say that it seals. The dashboard
  reaches it the way it always did, unsealed, with a line suggesting an update. A browser
  that already holds a key for that computer refuses anything unsealed from it.
- **A desktop app that seals, with a control plane from before pairing:** that dashboard
  doesn't seal, so the app turns its phones away. Update the control plane to use phone
  access again.
- The additions are an optional field, a close code and new frame types inside frames the
  bridge already piped, so nothing else changes for versions that don't know them. A bridge
  that doesn't know the close code still passes on the reason that comes with it, and the
  dashboard recognises either.

## Limits

| What | Limit |
| --- | --- |
| Frame from a phone | 256 KiB (bigger closes it, code 1009) |
| Frame on the link (a frame for a phone, wrapped) | 4 MiB; a bigger one ends that phone's session |
| Part of a message in one sealed frame | 128 KiB (about 171 KiB once sealed and encoded); longer messages go as several frames |
| Whole message from a phone / from the runner to a phone | 256 KiB / 4 MiB; a bigger one ends the session ("message too big") |
| Phones per thread / per computer | 3 / 12 (code 4429 beyond) |
| Phone idle (no frames either way) | 5 minutes (code 4408; the dashboard reconnects) |
| Link silent (the app pings every 30 s) | 90 seconds |
| First frame after connecting | 10 seconds |
| A phone's seal hello and first sealed frame | 10 seconds after it connects (code 4412 without the hello, 4408 without the frame) |
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
