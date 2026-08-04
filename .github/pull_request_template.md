## What this changes

<!-- One or two sentences. If it changes the wire protocol or a public type,
     say so here rather than leaving it to the diff. -->

## Type of change

- [ ] Bug fix
- [ ] New feature (backwards compatible)
- [ ] Breaking change to the published API or the wire protocol
- [ ] Documentation
- [ ] Build, CI, or tooling

## Protocol impact

- [ ] No change to the wire protocol
- [ ] Additive change (new method or event; existing peers keep working)
- [ ] Breaking change — describe the migration and whether `PROTOCOL_VERSION`
      needs to move

A new method or event needs: an entry in the type tables, a runtime validator,
a test for the rejection case, and a line in `docs/protocol.md`.

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
      (release-please derives the version and changelog from them)
- [ ] `bun run lint:check`, `bun run typecheck`, `bun run test:coverage`, and
      `bun run build && bun run verify:build` all pass
- [ ] No runtime dependency was added — this package ships zero
- [ ] Neither `host.ts` nor `guest.ts` imports anything framework-specific
- [ ] Tests cover the untrusted-input path, not only the happy path
- [ ] Docs updated if the developer-facing surface changed
