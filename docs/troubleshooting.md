# Troubleshooting

Every failure in this package is a `BridgeError` with a stable `code` and a
message written to be read by a person. Start with the code.

```js
try {
	const bridge = await connect({ platformOrigin: 'https://app.narrative.io' })
} catch (error) {
	console.error(error.code, error.message)
}
```

## Turn the log on first

Before theorising, look at what actually crossed the boundary:

```js
connect({
	platformOrigin: 'https://app.narrative.io',
	onLogEntry: (entry) => console.debug(entry.direction === 'sent' ? '→' : '←', entry.label, entry.message),
})
```

A healthy connection produces exactly this, in this order:

```
→ hello → https://app.narrative.io
← handshake (capabilities: getToken, getContext)
```

If you see the `hello` and nothing else, the platform is not answering — jump to
[`timeout`](#timeout). If you do not even see the `hello`, `connect()` rejected
before posting; that is [`bad_request`](#bad_request).

## Error codes

### `timeout`

**On `connect()`:** no handshake arrived within `connectTimeoutMs` (default 15s).
In order of likelihood:

1. **Your app is not embedded.** Someone opened its URL directly. Expected —
   render a standalone notice.
2. **`platformOrigin` does not match the embedding page.** It must be an exact
   origin match: scheme, host, and port. `https://app.narrative.io` and
   `https://app.narrative.io/` are the same origin, but
   `http://localhost:3000` and `http://localhost:4000` are not, and neither are
   `https://narrative.io` and `https://app.narrative.io`. Log
   `document.location.ancestorOrigins[0]` while debugging to see what actually
   framed you — then hard-code that value rather than reading it at runtime.
3. **The platform has not registered your origin**, so its side never opens a
   bridge for your frame.
4. **`connect()` runs too late.** If your framework's mount blocks for longer
   than the timeout before `connect()` is reached, move the call to module scope.

**On a request:** the platform accepted the request and never answered within
`requestTimeoutMs` (default 10s). Usually a slow token mint. Retry.

### `bad_request`

**From `connect()`, immediately:** `platformOrigin` was missing, empty, an empty
array, or `'*'`. A wildcard is rejected on purpose — it would let any page that
framed you impersonate the platform.

**From `pathChanged()` (thrown synchronously):** the argument was not a string.

**From `getToken()`:** the options argument was not an object. It takes
`{ minTtlSeconds }`, not a bare number.

**From a request:** either the platform rejected your params, or the platform's
response failed validation on your side. A message containing "malformed result"
is the latter — the platform sent something that is not a valid `TokenGrant` or
`Context`. That is a platform bug; report it with the log entry.

### `unauthorized`

There is no signed-in platform user, so the platform cannot describe the session.
Arrives on `connect()` as a refused handshake. Nothing to fix in your app —
render a signed-out state. If the session ends while you are running, you get
[`sessionEnded`](#session_ended) instead.

### `no_installation`

Your app is not installed for this company, so no installation-scoped token can
be minted. Check `bridge.hasInstallation` after connecting and render an install
prompt rather than calling `getToken()` and handling the failure:

```js
if (!bridge.hasInstallation) {
	showInstallPrompt()
	return
}
```

### `session_ended`

The platform session ended between your request and its answer. Subscribe to
`onSessionEnd` so you learn about it directly rather than through failing calls.

### `unsupported_method`

You called a method this platform does not implement — or, more likely, you are
speaking to an older platform than you developed against. Feature-detect:

```js
if (bridge.capabilities.includes('getToken')) {
	/* … */
}
```

### `unsupported_version`

The platform speaks a different major protocol version. Upgrade the package. The
message names both versions.

### `closed`

You called something after `bridge.close()`. In-flight requests reject with this
too. If it appears unexpectedly, something in your teardown path is closing the
bridge while work is still running.

### `internal`

The platform's handler threw for a reason it will not disclose to a third-party
frame. Deliberately opaque — the real cause is in the platform's own logs.
Report it with the log entry and a timestamp.

## Symptoms that are not error codes

### The frame is blank and there is no error at all

Your page never loaded, so your code never ran. Almost always a header on **your**
server refusing to be framed:

- `X-Frame-Options: DENY` or `SAMEORIGIN`
- A CSP `frame-ancestors` directive that excludes the platform

Chrome's console reports this on the *embedding* page, not yours. Remove the
header or name the platform:

```http
Content-Security-Policy: frame-ancestors https://app.narrative.io
```

[Making your app frameable](making-your-app-frameable.md) has the configuration
for common hosts, including the frameworks that send a blocking header unless you
turn it off.

Also check that your dev server is running, that its URL is reachable in a normal
tab, and — if the platform is on `https:` — that your app is too. Browsers block
mixed-content frames.

### `connect()` never settles

It always settles: it resolves on handshake or rejects on timeout. If you see
neither, you are not awaiting it, or `connectTimeoutMs` is far larger than you
think.

### The token works, then stops working after a while

You captured `token` once and reused it. Call `getToken()` before each request —
it caches internally, so this is cheap and it is what keeps renewal working:

```js
async function api(path) {
	const { token } = await bridge.getToken()
	return fetch(`${bridge.context.apiBaseUrl}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	})
}
```

### API calls return 403 with a valid token

The token is valid but its scopes do not cover what you asked for. Check
`grant.scopes` — that is a permissions question for the installation, not a bridge
problem.

### Navigation does nothing when I click a link

Your app is a controlled component: `pathChanged()` reports, and the platform's
`navigate` event is what switches the view. If you have no `onNavigate` handler,
nothing will ever render. See
[getting started](getting-started.md#navigation-your-app-is-a-controlled-component).

### Navigation flickers or loops

You are switching views on click *and* on `navigate`, or you are calling
`history.pushState` yourself. Do neither — the platform URL owns location.

### Context is stale after the user switches company

You cached `bridge.context` in a variable at startup. Read `bridge.context` when
you need it (it is a live getter) and subscribe to `onContextChange` to refetch
data tied to the old company.

### Everything works locally and fails in production

The three usual causes: `platformOrigin` still points at a development origin;
your production origin has not been registered with Narrative; or your production
server sends framing headers your dev server did not.

## Local development

Serve your app on an origin genuinely different from the platform's — a different
port is enough — so you exercise the real cross-origin path. Same-origin
development proves nothing: the origin checks pass trivially and you will
discover the difference in production.

In Chrome, `*.localhost` hostnames resolve to loopback with no `/etc/hosts` edit,
which makes the setup read the way it will in production:

```js
const bridge = await connect({ platformOrigin: 'http://platform.localhost:3000' })
```

One Chrome behaviour worth knowing: a page served from a public `https` origin may
not load a `localhost` frame until the user grants Local Network Access — and the
frame load fails **silently**, without prompting. A `fetch()` to the same origin
does prompt, so triggering one before retrying the frame is how you get the
permission dialog to appear.

## Still stuck

Open an issue with the version, the browser, the `BridgeError` code and message
verbatim, and the message log with token values redacted:
<https://github.com/narrative-io/app-bridge/issues>
