# Hosting embedded apps

This is the platform side of the bridge — `@narrative.io/app-bridge/host`. If you
are building an app to be embedded, you want
[getting started](getting-started.md) instead; this half of the protocol is
published so that the contract is inspectable and testable from both ends, not
because apps need it.

`host` is framework-free. It is a plain state machine over `postMessage`, with no
Vue, React, or DOM framework anywhere in it, which is also what makes it testable
without a browser. Reactive integration belongs in a thin wrapper on your side of
the boundary.

## Minimal host

```ts
import { createBridgeHost } from '@narrative.io/app-bridge/host'
import { BridgeError } from '@narrative.io/app-bridge/protocol'

const host = createBridgeHost({
	frame: iframeElement,
	// The registered origin for this app. The security boundary — never a
	// wildcard, and never derived from the frame's current location.
	appOrigin: 'https://app.example',
	hasInstallation: () => Boolean(installation),
	handlers: {
		async getToken({ minTtlSeconds }) {
			if (!installation) {
				throw new BridgeError('no_installation', 'This app is not installed for your company.')
			}
			return mintInstallationToken(installation, minTtlSeconds)
		},
		async getContext() {
			if (!user) throw new BridgeError('unauthorized', 'No signed-in user.')
			return {
				user: { id: user.id, name: user.name, email: user.email },
				company: { id: company.id, name: company.name },
				tier: installation?.tier ?? 'free',
				apiBaseUrl: 'https://api.narrative.io',
				protocolVersion: 1,
			}
		},
		onPathChanged(path) {
			// Mirror the guest's path into your own URL — see "Routing" below.
			router.replace({ hash: `#${path}` })
		},
	},
	onStateChange: (state) => {
		// 'connecting' | 'connected' | 'failed' | 'closed'
		spinnerVisible = state === 'connecting'
	},
})
```

Call `host.destroy()` when the frame goes away. It removes the window listener,
closes the port, and moves the host to `closed`.

## The frame

```html
<iframe
	src="https://app.example/reports"
	sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
	allow="camera 'none'; microphone 'none'; geolocation 'none'"
	title="Acme Audience Tools"
></iframe>
```

`allow-same-origin` looks alarming and is not: the guest is cross-origin, so this
grants the app **its own** origin, not yours. Without it the app gets an opaque
origin with no storage and no ability to call its own API. `allow-popups` is
usually needed for OAuth flows; apps that redirect at the top level may also need
`allow-popups-to-escape-sandbox`.

Also set CSP `frame-src` to the registered origins rather than `*`, so a URL bug
cannot cause an arbitrary page to be framed.

**Never put a credential in the frame URL.** It reaches referrers, server logs,
and browser history. Tokens are pull-only, over the port.

## The four things a host must get right

### 1. `getContext` must fail loudly, not slowly

The handshake cannot complete without a context, so `getContext` is called before
the guest connects. If it throws, the host refuses the handshake with the error's
code and the guest's `connect()` rejects with a usable reason. Throw a
`BridgeError` with the code you want the app to see; anything else becomes
`internal`, with the real cause going to your warning channel rather than into
the frame.

### 2. Push changes; do not make the guest poll

```ts
host.contextChanged(buildContext()) // the user switched company
host.sessionEnded('expired') // session lapsed — tokens are dead
host.sessionEnded('logout') // user signed out
```

A long-lived frame that survives navigation will otherwise never hear about a
company switch, and will keep using a token minted under a session that no longer
exists.

### 3. Routing: the guest is a controlled component

Your URL is the single source of truth. The loop is:

- Your route changes for any reason — a tab switch, a deep link, the browser back
  button — and you call `host.navigate(path)`.
- The guest reports its own navigation as `onPathChanged(path)`; you write that
  into your URL, which comes back around as a `navigate`.

Because the guest only ever renders on `navigate`, the flow is unidirectional and
your router keeps owning history. Deep links and refresh work without either side
maintaining a history stack.

One detail worth knowing if you keep frames alive across navigation: putting the
guest's subpath in a **path segment** will look like a different route to most
routers, which typically means a remount — and a remount reloads the app. Putting
it in the **hash** keeps guest navigation same-route, so the frame survives.

### 4. Handle reconnection by doing nothing

A reloaded or reactivated guest sends a fresh `hello`; the host tears down the
stale port and issues a new channel automatically. If your frame element is
replaced, create a new host against the new element.

## States

| State | Meaning |
|---|---|
| `connecting` | Waiting for the guest's `hello`. |
| `connected` | Handshake complete; the port is live. |
| `failed` | No `hello` within `helloTimeoutMs` (default 15s), a version mismatch, or `getContext` failed. |
| `closed` | `destroy()` was called. |

`failed` is the state to design a UI for. The common causes are an app that is
down, an app that does not speak the protocol, and — most often in development —
an app whose own `frame-ancestors` or `X-Frame-Options` header refuses to be
framed at all. Offering a retry that remounts the frame covers most of them.

## Observability

```ts
createBridgeHost({
	// …
	onLogEntry: (entry) => messageLog.push(entry),
	onProtocolWarning: (message) => logger.warn(message),
})
```

`onLogEntry` sees every message in both directions, handshake included, with a
short human-readable `label`. Token grants pass through it — redact before
persisting.

`onProtocolWarning` receives protocol anomalies: unknown events, malformed
payloads, handler crashes. These come from an untrusted guest, so they are
reported rather than thrown. It defaults to `console.warn`; route it into your own
logging so a misbehaving app is visible rather than merely tolerated.

## Host API reference

### `createBridgeHost(options): BridgeHost`

| Option | Type | Default | |
|---|---|---|---|
| `frame` | `FrameLike` | — | **Required.** The iframe element (anything with a `contentWindow`). |
| `appOrigin` | `string` | — | **Required.** The registered origin. `'*'` throws `bad_request`. |
| `handlers` | `BridgeHostHandlers` | — | **Required.** `getToken`, `getContext`, `onPathChanged`. |
| `hasInstallation` | `() => boolean` | — | **Required.** Lets the app render an install prompt without a failed call. |
| `helloTimeoutMs` | `number` | `15000` | How long to wait for `hello` before `failed`. |
| `listenTarget` | `MessageListenTarget` | `globalThis` | Where the window listener is installed. |
| `onStateChange` | `(state) => void` | — | State transitions. |
| `onLogEntry` | `(entry) => void` | — | Every message, both directions. |
| `onProtocolWarning` | `(message: string) => void` | `console.warn` | Protocol anomalies. |

### `BridgeHost`

| Member | |
|---|---|
| `state` | Current state (getter). |
| `navigate(path)` | Tell the guest to show this path. |
| `contextChanged(context)` | Push a new context. |
| `sessionEnded(reason)` | `'expired'` \| `'logout'`. |
| `destroy()` | Remove the listener, close the port, move to `closed`. |

Calls made while not `connected` are dropped and reported through
`onProtocolWarning` rather than throwing — a host should not crash because a
frame went away mid-update.
