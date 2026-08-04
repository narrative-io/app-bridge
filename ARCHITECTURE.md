# Architecture

Why the bridge is shaped the way it is. This is the document to read before
proposing a change to the protocol, and the one that explains why several
obvious-looking features are absent on purpose.

For the wire format itself see [docs/protocol.md](docs/protocol.md); for the
security reasoning, [docs/security.md](docs/security.md).

## What this package is

A `postMessage` protocol with two implementations of it — one for the embedding
platform (`host`) and one for the embedded app (`guest`) — plus the shared types
and validators (`protocol`). Roughly a thousand lines, no dependencies, no
network calls, no framework.

The scope is deliberately narrow. The bridge carries **identity, authorization,
and navigation**. It is not a UI kit, not an API client, and not a general
`postMessage` framework.

## Constraints that shaped everything

### Zero runtime dependencies, as a rule rather than a goal

Third parties bundle this package into their applications. Every dependency it
carried would become bytes in someone else's bundle and supply-chain surface in
someone else's product. That single constraint decides several other things:

- **Validation is hand-written predicates**, not Zod or Valibot. The tables are
  keyed `Record<MethodName, …>`, so a message added without a validator fails
  compilation — the mechanism that would otherwise justify a schema library.
- **No HTTP client.** The bridge is `postMessage` and nothing else. Apps call the
  API with plain `fetch` and a bearer token, which is a three-line pattern and
  needs no abstraction.
- **Dev dependencies stay minimal too.** A compiler, a test runner, a linter, and
  a commit linter. Building a few hundred lines of protocol code should not need
  a plugin ecosystem.

### Authored in TypeScript, published as JavaScript

The package ships `dist/*.js` plus `dist/*.d.ts`, so a plain-JavaScript consumer
needs no TypeScript toolchain and still gets editor autocomplete — editors read
`.d.ts` for JS projects automatically. A TypeScript consumer gets full types.

The inverse — authoring in JavaScript with hand-maintained declarations — is
worse: nothing checks the typings against the implementation, so they drift.
JSDoc with generated declarations is legitimate in general, but this protocol
leans on mapped types and a discriminated envelope union, which JSDoc expresses
poorly.

There is also an IIFE build that attaches one global, because a developer with a
`<script>` tag and no bundler is a real and likely case rather than an
afterthought. It contains only the guest surface.

### Types are not a substitute for validation

Types vanish at runtime, so a vanilla-JavaScript app gets no compile-time
protection. That is not the main reason to validate, though: **the guest is
untrusted.** Types never validate untrusted input, and a TypeScript app can post
arbitrary garbage exactly as easily as a JavaScript one. Runtime validation is
required by the security model, and it gives JavaScript consumers the guardrails
they would otherwise lack.

For a JavaScript consumer the error message *is* the type system, hence: named
error classes with stable `code` values rather than bare strings; frozen public
objects; argument checks that name the offending field; and a message log so a
developer can watch the whole conversation.

## The protocol

### It is smaller than you would expect

One handshake, two methods, four events. Several features that embedding
protocols usually carry are absent because they exist to work around a frame not
owning its own viewport or its own history — and both of those are better fixed
than messaged around. See "Decisions" below.

### The handshake is guest-initiated

Host-initiated has an unwinnable race: the host would post on iframe `load`, but
the guest may not have installed its listener yet. A guest that posts when it is
ready cannot be too early, so the guest speaks first.

The handshake carries the initial context, so there is no round-trip before the
app's first render — a bridge round-trip can never beat first paint, so anything
needed that early must arrive with the handshake or in the URL.

### Two window messages, then a private channel

`hello` and `handshake` are the only window-level posts. The handshake transfers
a `MessagePort`, and the host then stops acting on window messages for that frame
entirely — post-handshake traffic is unreachable from other windows by
construction rather than by filtering.

### Compatibility is designed in, not left to convention

- The version is **checked**, not sniffed: an unknown major is refused with
  `unsupported_version` rather than degrading into a partially-working state.
- The handshake advertises a **capability list**, so guests feature-detect.
- **An unknown method is an error**, never a silent drop. A protocol that
  swallows what it does not recognise lets one side's feature rot undetected
  while the other keeps sending it — the single most expensive failure mode a
  long-lived message protocol has.
- An unknown **event** is ignored but warned about, so adding one cannot break an
  older peer.
- Every request resolves or rejects; a guest-side timeout means nothing hangs.

### No root export

The package exports `./guest`, `./host`, and `./protocol`, and importing it bare
resolves nothing. That makes it impossible for an app to accidentally bundle
`host` — the platform's side of the conversation — and the IIFE build contains
only the guest surface for the same reason. CI asserts both properties.

## Decisions

### Look and feel is excluded from the protocol entirely

No theme mode, no design tokens, nothing presentational, and nothing of the kind
should be added. The bridge carries facts, not presentation.

The argument for including them is real: shared theme tokens would close most of
the visual seam between an embedded app and its host. The argument against wins
anyway. Presentational fields make every app responsible for interpreting a
vocabulary it did not design, and they make the platform's visual language a
versioned wire contract that cannot change without breaking apps. If Narrative
ever offers embedded apps a shared visual language, it ships as a separate UI
package, versioned and adopted on its own schedule.

### Fixed viewport, not host-resized

The common alternative has the guest measure its content with a `ResizeObserver`
and post a height, which the host writes to `iframe.style.height`. It works, and
it brings resize feedback loops, magic padding constants, and scroll position
jumping whenever content changes.

Instead the host gives the frame a fixed viewport and the guest scrolls
internally: the host owns layout, the guest owns its scroll region. This deletes
two messages and a class of jank, and matches how the established embedded-app
surfaces work.

The trade-off is real: an app can no longer make the host page grow with its
content. A nested scroll region is predictable in a way a host-resized frame is
not, so it is worth taking — but it changes how an embedded app *feels*, which
makes it a product decision as much as an engineering one.

### The guest is a controlled component

Making the browser back button work across a frame boundary usually means a
hand-rolled history stack on the host and a "go back" message from the guest. It
is the most error-prone code in every implementation that does it.

Instead the guest's subpath lives in the platform URL, and the flow is
unidirectional, exactly like a controlled input: the guest reports
`pathChanged`, the host writes it into its URL, and the URL change comes back as
`navigate`, which is the only thing that switches the guest's view. The host's
own router keeps owning history, so back, forward, deep links, and refresh work
without either side maintaining a stack.

One practical detail: whether the subpath rides in a path segment or the hash is
the host's choice, but it is not arbitrary. A router that keys views by path will
treat a path-embedded subpath as a different route, which typically remounts the
frame — reloading the app on every internal navigation. Hash navigation is
same-route, so the frame survives.

### The frame URL carries nothing sensitive

The token never goes in the URL: it would leak into referrers, server logs, and
browser history. Pull-only, always.

The URL is still the right channel for anything a guest needs before first paint,
since a bridge round-trip cannot beat it — but with presentation out of scope,
nothing currently qualifies beyond the guest's initial path, which travels as the
path itself.

### The host ships in the same package as the guest

An alternative would be two packages, so an app cannot even resolve the host
code. One package with no root export achieves the same practical outcome, and
keeps the two implementations of one protocol in one place where a change to the
wire format cannot update one side and forget the other. The tests exercise both
halves against each other, which is only cheap because they are together.

### Considered and rejected: a proxy model

The guest would call the Narrative API *through* the bridge and never hold a
token at all. This is strictly more secure — nothing to leak, instantly
revocable — and it was rejected.

It makes the host a bottleneck for every request, breaks large and streaming
payloads, and gives the app's own backend no path to the same API, since the
proxy exists only inside a browser tab. For a data platform, where responses can
be very large and an app's server-side component is normal rather than
exceptional, direct API access with a short-lived, installation-scoped token is
the right shape. It is recorded here because it is the first thing a security
reviewer asks about.

## Testing approach

The suite runs under **plain Node, not a DOM environment**. Both sides are
written against structural interfaces (`GuestWindowLike`, `FrameLike`,
`MessageListenTarget`) rather than the real `window`, so a stray `document`
reference fails in the test suite rather than in a consumer's bundler.

`src/testing/embeddingWorld.ts` wires two fake windows the way a real embedding
is: the guest's `parent.postMessage` arrives on the platform window with the
guest's origin and the frame's `contentWindow` as `source`; the platform's post
arrives on the guest window with the platform's origin and any transferred
ports. `targetOrigin` is honoured — a post whose target matches neither `'*'` nor
the receiving origin is dropped, as a browser would drop it. The `MessagePort`
objects are Node's real ones, so port traffic is genuinely asynchronous rather
than a stubbed queue.

That harness is what makes the interesting tests possible: a `hello` from the
wrong origin, a `hello` from the right origin but the wrong window, a raw port
posting methods the client library would never send. Coverage thresholds exist as
a ratchet — for a security boundary, a newly added line with no test is worth
failing CI over.

The harness is deliberately **not published**. It is excluded from the build and
from the tarball; exposing it would make an internal test fixture a public
compatibility commitment.

## What is deliberately not here

- **No API client.** Apps use `fetch`. Nothing in this package makes a network
  request, which is the main thing keeping the dependency count at zero.
- **No framework integration.** `host` and `guest` are plain functions. Reactive
  wrappers belong in the consumer, on their side of the package boundary.
- **No UI.** The message log exposes data (`onLogEntry`); rendering it is the
  consumer's job.
- **No storage.** The bridge holds a token in memory and nothing else. Persisting
  credentials is not its decision to make.
