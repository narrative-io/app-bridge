# Example: an embedded app

A complete app that runs inside the Narrative platform, in about two hundred
lines. It imports `@narrative.io/app-bridge/guest` and calls `fetch`, and uses
nothing else — no framework, no state library, no build plugins.

That constraint is the demonstration rather than an aesthetic: if anything here
needed a dependency, the bridge would have a gap.

## What it shows

- **Origin pinning** — [`src/main.ts`](src/main.ts) starts with
  `PLATFORM_ORIGINS`, hard-coded. Read that first; it is the security decision
  the whole package is built around.
- **Context on first paint** — the handshake carries user, company, and tier, so
  there is no round-trip before the app renders.
- **Calling the API** — a bearer token from `getToken()` and plain `fetch`, with
  `getToken()` called *inside* the request rather than once at startup.
- **Controlled-component navigation** — links report `pathChanged`; the view
  switches only when the platform answers with `navigate`. Back, forward, and
  deep links work without the app touching `history`.
- **Live platform changes** — `onContextChange` for a company switch,
  `onSessionEnd` for a session that lapses.
- **The states that are easy to forget** — a connecting state painted
  immediately (`connect()` waits up to 15 seconds before giving up), a
  "not embedded" state with the real error code, and an install prompt driven by
  `hasInstallation` rather than by a call you know will fail.

## Running it

From the repository root:

```bash
bun install
bun run build                              # the example compiles against dist/
bun run --cwd examples/embedded-app dev    # http://localhost:5174
```

Open it directly and you get the "not embedded" state, which is what a real app
should show rather than a blank page. To see it connected, embed it in a page
running the host side of the bridge.

## Deploying an app like this

Deliberately absent here: any deployment configuration. Your hosting is your
choice, and prescribing ours would teach you nothing about the bridge.

One deployment concern is not optional, though, and it is the most common reason
a third-party app shows a blank frame: **your server must allow the platform to
frame you.** See
[docs/making-your-app-frameable.md](../../docs/making-your-app-frameable.md) for
the exact header configuration on common hosts.

## Note for maintainers

This example is linked to the repository root (`file:../..`), so it compiles
against the local build and through the same export map a third party gets — not
a tsconfig path alias, which would bypass the package boundary. CI typechecks,
tests, and builds it on every run, which makes it a consumer test as well as
documentation: a breaking change to the guest surface fails here before a
release rather than after one.
