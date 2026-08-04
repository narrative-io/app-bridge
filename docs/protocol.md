# Wire protocol

Version `1`. This is a reference for anyone implementing either side without
this package, or debugging what they see in a message log. If you are building an
app, [getting started](getting-started.md) is the document you want — the
protocol is the thing this package exists so you do not have to think about.

Terms: the **host** is the embedding platform, the **guest** is the embedded
third-party app.

## Shape of the conversation

Exactly two messages are exchanged at the window level. Everything after that
travels on a transferred `MessagePort`, which no other window can reach.

```
guest                                                   host
  │                                                       │
  │──  hello  ─────────────────────────────────────────▶  │  window, targetOrigin = platformOrigin
  │                                                       │  checks event.origin AND event.source
  │  ◀───────────────────────  handshake + MessagePort ──│  window, targetOrigin = appOrigin
  │                                                       │
  │══  req getToken  ══════════════════════════════════▶  │  port
  │  ◀══════════════════════════════════  res getToken ══│  port
  │══  evt pathChanged  ═══════════════════════════════▶  │  port
  │  ◀════════════════════════════════════ evt navigate ══│  port
```

The handshake is **guest-initiated**. Host-initiated has an unwinnable race: the
host would post on iframe `load`, but the guest's listener may not be installed
yet. A guest that posts when it is ready cannot be too early.

## Handshake

### 1. Guest → host: `hello`

Posted to `parent` with `targetOrigin` set to the platform origin the guest
trusts. A guest configured with several candidate origins posts one `hello` per
candidate; the browser delivers only the one whose target origin matches the
actual parent.

```ts
{ kind: 'nio-bridge:hello', v: 1 }
```

### 2. Host → guest: `handshake`

The host accepts a `hello` only when **both** checks pass:

- `event.origin === appOrigin` — the registered origin for this app
- `event.source === frame.contentWindow` — this particular frame

`event.origin` and `event.source` are both set by the browser and cannot be
forged by the sender. Checking origin alone would accept a message from any
window on that origin, including a popup the app opened.

The host then creates a `MessageChannel`, keeps `port1`, and makes its one and
only window-level post — transferring `port2`:

```ts
{
  kind: 'nio-bridge:handshake',
  v: 1,
  capabilities: ['getToken', 'getContext'],  // feature-detect against this
  context: Context,                          // no round-trip before first render
  hasInstallation: boolean,
}
```

The host then stops acting on window messages for that frame entirely. Anything
posted to the app's window after the handshake is ignored by construction, not by
filtering.

`capabilities` exists so guests feature-detect rather than version-sniff. A host
that gains a method advertises it; a guest that does not know it simply does not
use it.

### 3. Host → guest: `hello-rejected`

The host refuses, with a reason. Sent when the guest's `v` is a version the host
does not speak (`unsupported_version`), or when the host cannot assemble a
context — no signed-in user, for instance.

```ts
{ kind: 'nio-bridge:hello-rejected', v: 1, error: { code: ErrorCode, message: string } }
```

`v` is the version the **host** speaks, which is precisely the version a rejected
guest may not share. Guests must therefore not validate it — doing so would turn
a version mismatch into a connection timeout and lose the error that explains it.

### Reconnection

A guest that reloads, or a frame that is reactivated after being detached, simply
sends `hello` again. The host tears down the stale port and issues a fresh
channel. There is no separate reconnect message.

## Port messages

### Request (guest → host)

```ts
{ kind: 'req', id: string, method: string, params: object }
```

`id` is opaque to the host and echoed back on the response. Every request gets
exactly one response.

| Method | `params` | Result |
|---|---|---|
| `getToken` | `{ minTtlSeconds?: number }` | `TokenGrant` |
| `getContext` | `{}` | `Context` |

### Response (host → guest)

```ts
{ kind: 'res', id: string, ok: true,  result: object }
{ kind: 'res', id: string, ok: false, error: { code: ErrorCode, message: string } }
```

An unknown `method` gets `ok: false` with `unsupported_method`, never silence.
Malformed `params` get `bad_request`.

### Event (either direction)

Fire-and-forget; no acknowledgement.

```ts
{ kind: 'evt', name: string, payload: object }
```

| Event | Direction | `payload` | Meaning |
|---|---|---|---|
| `pathChanged` | guest → host | `{ path: string }` | The guest navigated internally; mirror it into the platform URL. |
| `navigate` | host → guest | `{ path: string }` | Show this path. The only thing that should switch a guest's view. |
| `contextChanged` | host → guest | `Context` | Context changed (for example, the user switched company). |
| `sessionEnded` | host → guest | `{ reason: 'expired' \| 'logout' }` | The platform session ended; tokens will stop working. |

An unrecognised event name is warned about, not acted on. It is not an error,
because adding an event must not break an older peer.

## Data types

```ts
interface Context {
	user: { id: number; name: string; email: string }
	company: { id: number; name: string }
	/** The installation's tier id, e.g. 'free'. */
	tier: string
	/** Base URL the app should call the Narrative API on. */
	apiBaseUrl: string
	protocolVersion: 1
}

interface TokenGrant {
	token: string
	/** ISO-8601 timestamp after which the token is no longer valid. */
	expiresAt: string
	/** Scopes the token carries, as `access:resource` strings. */
	scopes: string[]
}

type ErrorCode =
	| 'unauthorized'
	| 'no_installation'
	| 'session_ended'
	| 'unsupported_method'
	| 'unsupported_version'
	| 'bad_request'
	| 'timeout'
	| 'closed'
	| 'internal'
```

### What is deliberately absent

**Nothing presentational.** No theme mode, no design tokens, no colours, no
fonts. The bridge carries identity, authorization, and navigation — facts, not
presentation — and nothing of that kind should be added. If Narrative ever offers
embedded apps a shared visual language, it ships as a separate UI package,
versioned and adopted on its own schedule, rather than as protocol fields every
app is obliged to interpret.

**Anything about frame size.** The host gives the frame a fixed viewport and the
guest scrolls internally, so there is no height message and no host-driven
resize. See [ARCHITECTURE.md](../ARCHITECTURE.md) for why.

**Any credential in the frame URL.** Tokens are pull-only, over the port. A URL
reaches referrers, server logs, and browser history.

## Compatibility rules

These are the rules that keep both sides honest as the protocol grows.

- **The version is checked, not sniffed.** A `hello` carrying an unknown major
  version is refused with `unsupported_version`, rather than degrading into some
  partially-working state.
- **Capabilities, not versions, gate features.** The handshake advertises the
  methods the host implements. Guests check that list.
- **An unknown method is an error.** `unsupported_method` returns to the caller.
  A protocol that silently drops what it does not recognise lets one side's
  feature rot undetected while the other side keeps sending it.
- **An unknown event is ignored, and warned about.** Events are one-way and
  optional, so a new one must not break an older peer — but it should be visible
  in development.
- **Every request terminates.** Guest-side timeouts mean a host that never
  answers produces a rejection, not a hang.
- **Every inbound message is validated before it is acted on**, on both sides. In
  this implementation the validator tables are keyed by message name, so adding a
  message without a validator fails compilation.

## Adding a message

1. Add it to the type table in `src/protocol.ts` (`MethodParams`/`MethodResult`,
   or `GuestEventPayload`/`HostEventPayload`) and to the corresponding
   `*_NAMES` array.
2. Add its validator. The keyed `Record` types mean the build fails until you do.
3. Test the rejection path, not just the happy path — a malformed payload must be
   refused rather than passed to a callback.
4. Document it in the tables above.

Additive changes — a new method or event — do not move `PROTOCOL_VERSION`;
capability advertisement covers them. Only a change that breaks an existing
peer does.
