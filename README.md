# @narrative.io/app-bridge

The bridge between the [Narrative](https://narrative.io) platform and an
embedded third-party app UI.

An app registers the origin it is served from, the platform embeds it in a
sandboxed iframe, and this package carries authorization, navigation, and
context between the two over an origin-pinned `MessageChannel`.

- **Zero runtime dependencies**, and that is a hard rule rather than an
  aspiration. You bundle this package into your app, so every dependency it
  had would become supply-chain surface in your application.
- **Runtime-validated on both sides.** Types disappear when the code runs;
  every inbound message is checked structurally before it is acted on.
- **No network client.** The bridge is `postMessage` and nothing else. You call
  the Narrative API with plain `fetch` and the bearer token it hands you.
- **Nothing fails silently.** Unknown methods return errors, every request
  resolves or rejects, and all failures are `BridgeError`s with stable `code`s.

```bash
bun add @narrative.io/app-bridge   # or npm / pnpm / yarn
```

> **Stability.** Wire protocol version `1` is settled — the message shapes in
> [docs/protocol.md](docs/protocol.md) are what the platform speaks. The package
> stays on `0.x` while the first external integrations land, so a minor version
> may still adjust the JavaScript surface. Pin an exact version if that matters
> to you, and watch releases.

## Quick start

```js
import { connect } from '@narrative.io/app-bridge/guest'

// Pin the origins that may embed you. This is the security decision the
// whole package is built around — never use '*'.
const bridge = await connect({ platformOrigin: 'https://app.narrative.io' })

// Context arrives with the handshake, so there is no round-trip before your
// first render.
console.log(bridge.context.user, bridge.context.company, bridge.context.tier)

// Calling the Narrative API is plain fetch plus a bearer token. getToken()
// caches and renews automatically.
const { token } = await bridge.getToken()
const response = await fetch(`${bridge.context.apiBaseUrl}/datasets`, {
	headers: { Authorization: `Bearer ${token}` },
})

// Navigation: your app is a controlled component. Tell the platform where the
// user went, and switch views when the platform answers.
bridge.pathChanged('/reports')
bridge.onNavigate((path) => showView(path))

// The platform tells you about live changes; you never poll.
bridge.onContextChange((context) => showCompany(context.company))
bridge.onSessionEnd((reason) => showSignedOutBanner(reason))
```

No bundler? There is a `<script>` build that attaches a single global:

```html
<script src="https://unpkg.com/@narrative.io/app-bridge/dist/app-bridge.global.js"></script>
<script>
	NarrativeAppBridge.connect({ platformOrigin: 'https://app.narrative.io' }).then((bridge) => {
		document.title = bridge.context.company.name
	})
</script>
```

## Four rules that will save you an afternoon

1. **Call `connect()` as early as possible** — before your framework boots — so
   the handshake overlaps your app's own startup.
2. **Your app must be frameable.** An `X-Frame-Options: DENY` header, or a CSP
   `frame-ancestors` directive that excludes the platform, means your app cannot
   be embedded at all, no matter what the platform allows — the browser refuses
   before your code runs. See
   [making your app frameable](docs/making-your-app-frameable.md).
3. **Look and feel is yours.** The bridge deliberately carries no styling or
   theming information, and never will. It moves identity, authorization, and
   navigation — facts, not presentation.
4. **Client secrets never go in the browser.** The token `getToken()` hands you
   is installation-scoped and short-lived. Your own backend uses OAuth client
   credentials instead.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Connecting, calling the API, navigation, and the full guest API reference |
| [Making your app frameable](docs/making-your-app-frameable.md) | The server headers your app needs, by host. The most common cause of a blank frame |
| [Protocol](docs/protocol.md) | The wire format, message by message, and the compatibility rules |
| [Security model](docs/security.md) | What the bridge guarantees, what it does not, and what each side must do |
| [Hosting apps](docs/hosting.md) | The `host` surface, for a platform embedding apps |
| [Troubleshooting](docs/troubleshooting.md) | Every `BridgeError` code and what actually causes it |
| [Architecture](ARCHITECTURE.md) | Why the protocol is shaped this way, including the paths not taken |

## A working example

[`examples/embedded-app`](examples/embedded-app) is a complete embedded app built
from `guest` and `fetch` and nothing else — origin pinning, context on first
paint, a real API call, controlled-component navigation, and the states that are
easy to forget (connecting, not-embedded, not-installed).

It is compiled against this package's own build on every CI run, so it cannot
drift from the API it demonstrates.

## The surface, at a glance

One handshake, two methods, four events. Window-level traffic is exactly two
messages — `hello` from the app, `handshake` back with a transferred
`MessagePort` — and everything after that travels on the port, unreachable from
any other window.

| | name | direction |
|---|---|---|
| method | `getToken` | app → platform |
| method | `getContext` | app → platform |
| event | `pathChanged` | app → platform |
| event | `navigate` | platform → app |
| event | `contextChanged` | platform → app |
| event | `sessionEnded` | platform → app |

Three entry points, and no root export — importing the package bare resolves
nothing. That is deliberate: it makes it impossible for an app to accidentally
bundle `host`, which is the platform's side of the conversation.

| Subpath | For |
|---|---|
| `@narrative.io/app-bridge/guest` | An app being embedded. This is the one you want. |
| `@narrative.io/app-bridge/host` | A platform doing the embedding. |
| `@narrative.io/app-bridge/protocol` | Shared types and validators, if you need to name them. |

## Support

Bugs and feature requests: [GitHub issues](https://github.com/narrative-io/app-bridge/issues).
Security reports go to [security@narrative.io](mailto:security@narrative.io) —
see [SECURITY.md](.github/SECURITY.md).

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Narrative I/O, Inc.
