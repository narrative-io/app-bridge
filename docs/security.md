# Security model

Embedding is two mutually untrusting pages sharing a browser tab. This document
states what the bridge guarantees, what it cannot, and which obligations belong
to which side — because the failure mode of a bridge like this is a developer
assuming a property that was never provided.

To report a vulnerability, see [SECURITY.md](../.github/SECURITY.md).

## The threat model

The host treats the guest as **untrusted**. An embedded app is code written by
someone else, and it may be compromised, buggy, or hostile. Types offer nothing
here: they vanish at runtime, and a TypeScript app can post malformed messages
exactly as easily as a JavaScript one.

The guest treats the host as **authenticated but not blindly trusted**. The app
pins the origin it will talk to, and validates the shape of what comes back
rather than handing unverified data to application code.

Three attackers are worth naming:

- **A page that frames your app.** Any site can put your app in an iframe unless
  you stop it. If your app accepted a bridge handshake from whoever framed it, that
  site could drive your app and read the context and token intended for the
  platform.
- **A page the app opens, or another tab on its origin.** Same-origin windows can
  post to each other. Checking only the origin of an inbound message is not
  enough to know it came from the frame you are talking to.
- **A compromised app.** Once an app holds a token, it can do anything the
  token's scopes allow. Reducing that blast radius is the job of scoping and
  expiry, not of the transport.

## What the bridge guarantees

**Origin-pinned handshake, checked on both sides.** Every outbound
`postMessage` names a specific target origin — never `'*'`, which both
`connect()` and `createBridgeHost()` reject as a programming error. The host
accepts a `hello` only when `event.origin` matches the registered app origin
**and** `event.source` is that frame's `contentWindow`. Both are set by the
browser and cannot be forged by the sender. The guest accepts a handshake only
from an origin it named.

**A private channel after the handshake.** Exactly two window-level messages are
exchanged; the host transfers a `MessagePort` and then stops acting on window
messages for that frame. Port endpoints are not reachable by name from any other
window, so post-handshake traffic cannot be observed or injected by other frames
or tabs — including other frames on the same origins.

**Validation before action.** Every inbound message is checked structurally
before anything acts on it: the envelope, the method or event name, and the
payload. The guest also validates the host's *results*, so a malformed response
becomes a rejected promise rather than surprising data inside application code.

**No credential in a URL.** Tokens travel only over the port, on request. A URL
reaches referrers, server logs, and browser history.

**Failures that stay on their own side.** A host handler that throws sends the
guest an error code and a generic message; the underlying exception goes to the
host's own warning channel. Platform internals — connection strings, stack
traces, hostnames — never cross the boundary. Symmetrically, a malformed or
hostile guest message produces a warning on the host, never an exception that
takes the embedding page down.

**Zero runtime dependencies.** Apps bundle this package, so a dependency here
would be supply-chain surface in someone else's application. A dependency
appearing in the published package is treated as a security regression.

## What the bridge does not guarantee

**It does not stop other sites framing your app.** That is a header on your own
server. Send a `frame-ancestors` directive that names the platform:

```http
Content-Security-Policy: frame-ancestors https://app.narrative.io
```

Without it, a hostile page can frame your app. It still cannot complete a
handshake — your `platformOrigin` pin defeats that — but it can attempt
clickjacking against whatever your app renders.

**It does not decide what a token can do.** Scopes and expiry are set when the
token is minted. The bridge transports the grant and tells you its `scopes` and
`expiresAt`; it does not enforce them.

**It does not protect a token you leak.** Once `getToken()` resolves, the
credential is in your app's memory and your app's responsibility.

**It does not sandbox anything.** The `sandbox` attribute, `frame-src`, and
`allow` are set by the embedding page. The bridge cannot verify them and does not
try.

**It does not authenticate the app to the platform.** A registered origin is
evidence about *where* code is served from, not *what* that code does.

## Obligations of an app being embedded

1. **Pin your platform origins in code.** Hard-code the values, or read them from
   your own build configuration.

   Do **not** derive them from `document.location.ancestorOrigins` or
   `document.referrer`. That means trusting whoever framed you, which is the
   attack the origin pin exists to prevent. (A throwaway demo with nothing worth
   stealing may do it to work across preview deployments; a real app must not.)

2. **Send `frame-ancestors`** naming the platform origins, so only the platform
   can frame you.

3. **Do not persist tokens.** No `localStorage`, no `sessionStorage`, no cookie.
   They are short-lived and `getToken()` will hand you a fresh one. Call it
   before each request instead of holding the result.

4. **Never ship a client secret to the browser.** Your app's OAuth client
   credentials belong on your own backend. The token the bridge provides is the
   browser's only credential.

5. **Do not treat context as authorization.** `bridge.context` describes who the
   user is; the API decides what they may do. Use it to render, not to gate
   anything that matters.

6. **Redact tokens from logs.** `onLogEntry` sees every message, token grants
   included. Redact before sending log entries anywhere.

7. **Serve over HTTPS** (except `localhost` in development).

## Obligations of a platform doing the embedding

1. **Register origins deliberately and validate them.** The registered origin is
   the security boundary. Store an origin, not a URL with a path, and reject
   anything that is not a well-formed `https:` origin.

2. **Pass a specific `appOrigin`** to `createBridgeHost` — the registered origin
   for that app, never a wildcard or a value derived from the frame's current
   location.

3. **Sandbox the frame** and grant only what the app needs:

   ```html
   <iframe
   	src="https://app.example/…"
   	sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
   	allow="camera 'none'; microphone 'none'; geolocation 'none'"
   ></iframe>
   ```

   `allow-same-origin` grants the guest **its own** origin, not the host's — the
   guest is cross-origin, so this does not open a hole in the host. Omitting it
   would give the app an opaque origin with no storage and no ability to call
   its own API.

4. **Restrict CSP `frame-src`** to registered origins. A wildcard `frame-src`
   means any page can be framed by a URL bug or an open redirect.

5. **Mint narrow, short-lived tokens.** Scope them to the installation and
   intersect with the caller's own permissions; never fall back to the signed-in
   user's full-scope credential when an app has no installation. `getToken`
   returning `no_installation` is the correct answer.

6. **Keep the context narrow.** Send the fields an app needs to render, not an
   internal user object. Every field added is a field disclosed to every embedded
   app.

7. **Tell the frame when the session ends.** Call `sessionEnded` on logout or
   expiry so the app stops using credentials it cannot renew, rather than
   discovering it through a 401.

8. **Never let a handler's exception cross the boundary.** Throw `BridgeError`
   with a code for things the app should know about; everything else becomes a
   generic `internal` automatically.
