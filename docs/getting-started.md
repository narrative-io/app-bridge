# Getting started

This guide is for building an app that runs **inside** the Narrative platform,
in an iframe served from your own domain. It covers connecting, calling the API,
navigating, and reacting to changes on the platform side.

## Before you write any code

Three things have to be true, and none of them are in your JavaScript.

**1. Your app must be frameable.** If your server sends
`X-Frame-Options: DENY` / `SAMEORIGIN`, or a CSP `frame-ancestors` directive
that excludes the platform, the browser refuses to load your page in the frame
and no amount of bridge configuration helps. If you set `frame-ancestors` — and
you should — name the platform:

```http
Content-Security-Policy: frame-ancestors https://app.narrative.io
```

**2. Your origin must be registered with Narrative.** The platform will only
frame an origin it knows about, and pins the bridge conversation to it.

**3. You need to be served over HTTPS**, with the exception of `localhost`
during development.

## Connecting

Install the package:

```bash
bun add @narrative.io/app-bridge   # or npm / pnpm / yarn
```

Then connect as early in your startup as you can manage — ideally at module
scope in your entry file, before your framework boots. The handshake takes a
round-trip; overlapping it with your own initialisation means it is usually done
by the time you need it.

```js
import { connect } from '@narrative.io/app-bridge/guest'

const bridgePromise = connect({ platformOrigin: 'https://app.narrative.io' })

// … your framework boots …

const bridge = await bridgePromise
```

### `platformOrigin` is the security decision

`platformOrigin` pins both halves of the handshake: your `hello` is posted only
to that origin, and a handshake is accepted only from it. Get it wrong and
nothing connects. Set it to `'*'` and `connect()` rejects with `bad_request`,
because a wildcard would let any page that manages to frame you impersonate the
platform.

If you deploy against more than one platform environment, pass a list. Your app
says hello to each; the browser only delivers the post whose target origin
matches the page actually embedding you, so at most one can answer:

```js
const bridge = await connect({
	platformOrigin: ['https://app.narrative.io', 'https://app-staging.example'],
})
```

Deriving the list from `document.location.ancestorOrigins` — trusting whoever
framed you — is *not* a shortcut to this. It hands your bridge session to any
site that embeds your app.

### Handling the failure case

Your app will sometimes load outside the platform: someone opens the URL
directly, or your origin is not registered yet. Handle it rather than hanging:

```js
connect({ platformOrigin: 'https://app.narrative.io' }).then(renderApp, (error) => {
	// error is a BridgeError with a stable `code`
	renderStandaloneNotice(error.code, error.message)
})
```

See [troubleshooting](troubleshooting.md) for what each code means.

## Context

The handshake carries the initial context, so it is available synchronously on
the connected bridge — no round-trip before your first paint:

```js
bridge.context.user // { id, name, email }
bridge.context.company // { id, name }
bridge.context.tier // the installation's tier id, e.g. 'free'
bridge.context.apiBaseUrl // where to send API requests
bridge.hasInstallation // whether this company has installed your app
```

`user` is deliberately narrow. An embedded frame gets the fields it needs to
render and nothing else.

`hasInstallation` lets you render an install prompt without first making a call
you know will fail.

Context is not static — a user can switch which company they are acting as
without reloading your frame. Subscribe rather than caching it:

```js
bridge.onContextChange((context) => {
	// The company may have changed. Anything you fetched for the old one is stale.
	reloadFor(context.company.id)
})
```

`bridge.context` is a live getter, so it always reflects the latest value.

## Calling the Narrative API

`getToken()` returns a short-lived, installation-scoped credential. Use it as a
bearer token against `bridge.context.apiBaseUrl`. That is the whole pattern —
there is no client library to install:

```js
const { token } = await bridge.getToken()
const response = await fetch(`${bridge.context.apiBaseUrl}/datasets`, {
	headers: { Authorization: `Bearer ${token}` },
})
```

**Call `getToken()` before each request rather than holding the result.** It
caches internally and only crosses the bridge when the cached token is close to
expiry, so calling it often is cheap — and it is the only way your requests keep
working past the first expiry:

```js
// Do this.
async function api(path) {
	const { token } = await bridge.getToken()
	return fetch(`${bridge.context.apiBaseUrl}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	})
}

// Not this: `token` is a snapshot and will expire underneath you.
const { token } = await bridge.getToken()
const api = (path) => fetch(url + path, { headers: { Authorization: `Bearer ${token}` } })
```

If you need more remaining life than the default 30-second floor — a long upload,
say — ask for it, and a fresh token is minted if the cached one is too close to
the end:

```js
const { token } = await bridge.getToken({ minTtlSeconds: 300 })
```

Concurrent callers share one renewal, so firing ten parallel requests through
the helper above causes at most one token round-trip.

The grant also tells you what it can do, which is worth checking before you
offer a feature the installation is not scoped for:

```js
const grant = await bridge.getToken()
grant.token // the bearer token
grant.expiresAt // ISO-8601 timestamp
grant.scopes // e.g. ['read:datasets']
```

### What not to do with the token

- **Do not put it in a URL.** Query strings reach referrers, server logs, and
  browser history.
- **Do not persist it** to `localStorage`, `sessionStorage`, or a cookie. It is
  short-lived by design and the bridge will hand you a fresh one.
- **Do not send it to your own backend** as a way of acting on the user's
  behalf server-side. Your backend authenticates with its own OAuth client
  credentials, which never appear in a browser.

## Navigation: your app is a controlled component

The platform URL is the single source of truth for where the user is, which is
what makes deep links, refresh, and the browser back button work across the
frame boundary. The flow is unidirectional, exactly like a controlled input:

1. The user clicks something in your app. You call
   `bridge.pathChanged('/reports')`. **You do not change your view yet.**
2. The platform mirrors that path into its own URL.
3. The platform sends `navigate` back with the path.
4. Your `onNavigate` handler switches the view.

```js
function showView(path) {
	/* render */
}

// Links report; they do not navigate.
link.addEventListener('click', () => bridge.pathChanged('/reports'))

// The platform's answer is what actually navigates.
bridge.onNavigate(showView)
```

The same `navigate` event arrives when the user presses back or forward, or
opens a deep link, so one handler covers every case. Do not call
`history.pushState` yourself — you would be fighting the platform for the URL.

Paths are yours to define. Keep them stable, since they end up in URLs users
bookmark and share.

## When the platform session ends

If the signed-in user's platform session ends, tokens stop working. The platform
tells you rather than leaving you to discover it through a 401:

```js
bridge.onSessionEnd((reason) => {
	// reason: 'expired' | 'logout'
	stopPolling()
	showSignedOutState()
})
```

The cached token is discarded at the same time, so a later `getToken()` goes
back to the platform instead of returning something dead.

## Watching the conversation

Every message crossing the boundary can be observed. This is the fastest way to
understand what is happening during development:

```js
const bridge = await connect({
	platformOrigin: 'https://app.narrative.io',
	onLogEntry: (entry) => {
		// { at, direction: 'sent' | 'received', transport: 'window' | 'port', label, message }
		console.debug(entry.direction === 'sent' ? '→' : '←', entry.label)
	},
})
```

It is instrumentation only: exceptions thrown from your callback are swallowed,
so a broken logger cannot break the bridge. Redact token values before sending
log entries anywhere — they are credentials.

## Feature detection

`bridge.capabilities` lists the methods the embedding platform implements. Check
it rather than testing a version number, so your app keeps working against both
older and newer platforms:

```js
if (bridge.capabilities.includes('getToken')) {
	enableApiFeatures()
}
```

## Cleaning up

If your app tears down its bridge — a single-page host unmounting your view, for
instance — call `close()`. In-flight requests reject with `closed`, the port is
released, and later calls fail fast instead of hanging:

```js
bridge.close()
```

Most embedded apps live as long as the frame does and never need this.

## Guest API reference

### `connect(options): Promise<AppBridge>`

| Option | Type | Default | |
|---|---|---|---|
| `platformOrigin` | `string \| string[]` | — | **Required.** Origin(s) allowed to embed this app. `'*'` is rejected. |
| `connectTimeoutMs` | `number` | `15000` | How long to wait for the handshake before rejecting with `timeout`. |
| `requestTimeoutMs` | `number` | `10000` | Per-request timeout. |
| `onLogEntry` | `(entry: BridgeLogEntry) => void` | — | Observe every message, both directions. |
| `windowRef` | `GuestWindowLike` | `globalThis` | Test injection point. |

Rejects with a `BridgeError`: `bad_request` for a bad origin, `timeout` when
nothing answers, or whatever code the platform used to refuse the handshake.

### `AppBridge`

| Member | |
|---|---|
| `context: Context` | Live context. Starts from the handshake, updated on `contextChanged`. |
| `hasInstallation: boolean` | Whether this company has installed the app. |
| `capabilities: readonly string[]` | Methods the platform implements. |
| `getToken(params?): Promise<TokenGrant>` | Cached token; renews when under `minTtlSeconds` (default 30) of life remains. |
| `getContext(): Promise<Context>` | Force a re-read. Rarely needed — prefer `onContextChange`. |
| `pathChanged(path): void` | Report internal navigation. Throws `bad_request` on a non-string. |
| `onNavigate(cb): () => void` | The platform wants this path shown. Returns an unsubscribe function. |
| `onContextChange(cb): () => void` | Context changed. |
| `onSessionEnd(cb): () => void` | Platform session ended (`'expired'` \| `'logout'`). |
| `close(): void` | Reject in-flight requests, release the port. |

All errors are `BridgeError` instances with a stable `code` — see
[troubleshooting](troubleshooting.md) for the full list.
