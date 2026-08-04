# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities to **[security@narrative.io](mailto:security@narrative.io)**
rather than opening a public issue. You will receive a response within 48 hours.
If the issue is confirmed we will release a patch as quickly as the complexity
allows.

If the report concerns the Narrative platform rather than this package, the same
address is the right one.

## Supported versions

| CVSS v3.0 | Supported versions                        |
| --------- | ----------------------------------------- |
| 9.0–10.0  | Releases within the previous three months |
| 4.0–8.9   | Most recent release                       |

## What this package is responsible for

The bridge is a security boundary between a page you control and a page someone
else controls, so it is worth being precise about which half of that boundary
lives here.

**In scope for a vulnerability report:**

- Accepting a handshake, request, event, or response from an origin or window
  the caller did not name.
- Any path by which a message reaches an application callback without passing
  the runtime validators, or by which a malformed message crashes either side.
- Traffic that escapes the transferred `MessagePort` back onto the window after
  the handshake, or a port that survives a `close()`/`destroy()`.
- Credentials or platform internals reaching a place the protocol does not
  document — an error message, a log entry, a URL.
- A dependency appearing in the published package. It ships with zero runtime
  dependencies, and a change to that is a security regression.

**Out of scope, because they are properties of the embedding page or the app:**

- Whether the embedding platform sandboxes the frame, restricts `frame-src`, or
  validates the origin it registered for an app.
- What an app does with a token after `getToken()` resolves — storing it in
  `localStorage`, logging it, or forwarding it elsewhere.
- The scopes a token carries and what the API authorizes it to do.
- An app choosing to accept any embedder (for example by deriving
  `platformOrigin` from `document.location.ancestorOrigins`) instead of pinning
  the origins it trusts.

## Security properties the package maintains

- Every outbound `postMessage` names a specific target origin. A wildcard `'*'`
  origin is rejected as a programming error by both `connect()` and
  `createBridgeHost()`.
- Inbound window messages are checked on **both** `event.origin` and
  `event.source`; the host acts on exactly one window-level message (`hello`)
  and ignores everything else, including anything posted after the handshake.
- Exactly two window-level messages are exchanged. All subsequent traffic is on
  a transferred `MessagePort`, which is unreachable from any other window.
- Every inbound message is validated structurally before it is acted on. The
  validator tables are keyed by message name, so a message added without a
  validator fails compilation.
- Unrecognised methods return an error to the caller. Nothing is silently
  dropped.
- Host handler failures are reported to the guest as an error code and a
  generic message; the underlying exception goes to the host's own warning
  channel, never across the boundary.
- No credential is ever placed in the frame URL, where it would reach referrers,
  server logs, and browser history.
