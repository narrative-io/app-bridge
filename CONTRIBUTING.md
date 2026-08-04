# Contributing

Thanks for your interest in the app bridge. Bug reports and fixes are very
welcome. Protocol additions are welcome too, but read
[ARCHITECTURE.md](ARCHITECTURE.md) first — several plausible-looking features are
absent by decision rather than by omission, and the reasoning is recorded there.

## Getting set up

```bash
git clone https://github.com/narrative-io/app-bridge.git
cd app-bridge
bun install
```

[Bun](https://bun.sh) is the package manager and task runner. The tests run under
Node's runtime via Vitest, so no browser is needed.

```bash
bun run test           # once
bun run test:dev       # watch
bun run test:coverage  # with thresholds enforced
bun run typecheck      # tsc --noEmit
bun run lint           # Biome, with fixes
bun run lint:check     # Biome, no fixes (what CI runs)
bun run build          # dist: ESM + .d.ts + source maps + the <script> bundle
bun run verify:build   # assert the export map resolves and the global attaches
```

Before opening a PR, the whole gate in one line:

```bash
bun run lint:check && bun run typecheck && bun run test:coverage && bun run build && bun run verify:build
```

## The rules that are not negotiable

These are properties of the package rather than style preferences, and a PR that
breaks one will be asked to change regardless of how good the feature is.

1. **Zero runtime dependencies.** Apps bundle this package; a dependency here
   becomes supply-chain surface in someone else's product. `dependencies` and
   `peerDependencies` stay empty.
2. **No framework anywhere**, including in `host`. No Vue, React, Svelte, or DOM
   framework, and no import of a real `window` or `document` — both sides are
   written against structural interfaces so the suite can run under plain Node.
3. **No network calls.** The bridge is `postMessage`. If a feature seems to need
   `fetch`, it belongs in the consumer.
4. **Nothing presentational in the protocol.** No theme, tokens, colours, or
   fonts. See ARCHITECTURE.md for why.
5. **Every inbound message is validated before it is acted on.** The validator
   tables are keyed by message name, so the compiler enforces this — do not work
   around it with a cast.
6. **Nothing fails silently.** Unknown methods return an error; unknown events
   warn. Never add a bare `default: break`.
7. **No platform internals cross the boundary.** Host handler failures become a
   code and a generic message; the real cause goes to `onProtocolWarning`.

## Working on the protocol

Adding a method or an event means, in order:

1. An entry in the type table in `src/protocol.ts` and in the matching
   `*_NAMES` array.
2. A runtime validator. The build fails until this exists.
3. Tests for both the happy path **and** the rejection path — a malformed payload
   must be refused rather than reaching a callback.
4. A row in the tables in `docs/protocol.md`.

Additive changes do not move `PROTOCOL_VERSION`; capability advertisement covers
them. Only a change that breaks an existing peer does, and that needs a
discussion in an issue before the PR.

## Tests

Specs sit next to the code they cover (`src/*.spec.ts`) and run under
`environment: 'node'`.

`src/testing/embeddingWorld.ts` gives you two fake windows wired the way a real
embedding is, with real `MessagePort`s, so port traffic is genuinely async. Use it
rather than mocking `postMessage`: it is what makes the security tests possible —
a `hello` from the wrong origin, a `hello` from the right origin but the wrong
window, a raw port posting messages the client library would never send.

For anything touching the security boundary, the interesting test is the one where
the *guest misbehaves*. A test that only proves the happy path works has not
tested the thing that matters.

Coverage thresholds are enforced. They are a ratchet: if your change lowers
coverage, add the test rather than lowering the threshold.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
This is enforced in CI, and it matters more than usual here: releases are
automated with [release-please](https://github.com/googleapis/release-please),
which derives the version bump and the changelog from commit subjects. A
mislabelled commit produces a wrong release.

```
feat(guest): renew the token when it is inside the requested TTL window
fix(host): reject the handshake when the context handler throws
docs(protocol): document the hello-rejected version rule
chore(deps): bump typescript to 5.9.3
```

A breaking change needs `!` after the type (`feat(guest)!: …`) or a
`BREAKING CHANGE:` footer.

Check your messages before pushing:

```bash
bunx commitlint --from origin/main --to HEAD --verbose
```

Releases happen automatically: merging to `main` opens or updates a release PR;
merging that PR tags the release and publishes to npm via OIDC trusted
publishing. Do not bump the version in `package.json` by hand.

## Pull requests

- One concern per PR.
- Say in the description whether the wire protocol changed. The template asks.
- Match the surrounding code. Comments in this codebase explain *why*, not what —
  the security-relevant decisions are load-bearing and the next reader needs the
  reasoning, not a paraphrase of the line below.
- Update the docs when the developer-facing surface changes. Docs that lag the
  code are worse than no docs, because they are believed.

## Security

Do not open a public issue for a vulnerability. Email
[security@narrative.io](mailto:security@narrative.io) — see
[SECURITY.md](.github/SECURITY.md), which also sets out which side of the
embedding boundary each class of issue belongs to.
