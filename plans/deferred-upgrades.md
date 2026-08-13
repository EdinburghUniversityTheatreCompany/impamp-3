# Deferred upgrades

Dependency bumps that were attempted, could not be landed green, and were
reverted. Each entry records what blocked it and what has to be true to retry.

## typescript 7.0.2 — blocked on typescript-eslint (2026-08-13)

**Landed instead:** typescript 6.0.3 (still a major over the previous 5.9.3).

TypeScript 7 is the native Go port (tsgo). It typechecks this repo cleanly and
`next build` succeeds on it — the blocker is downstream:

```
typescript-eslint does not support TS 7.0.
Error: typescript-eslint does not support TS 7.0.
    at node_modules/eslint-config-next/node_modules/typescript-eslint/dist/index.js:52:11
```

`typescript-eslint` hard-refuses to load against the TS 7 API, so `npm run lint`
crashes outright (exit 2) rather than reporting findings. The refusal is
deliberate and version-gated, not a peer-range warning that could be overridden.

Upstream tracking: https://github.com/typescript-eslint/typescript-eslint/issues/10940
("Use TS 7 (tsgo / typescript-go) for type information", open, last updated
2026-07-09). TypeScript's own guidance is to run TS 7 side by side with the TS 6
API for tooling that needs it:
https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0

**Retry when** typescript-eslint ships TS >=7.1 support and `eslint-config-next`
picks up that release. Then `npm install --save-dev typescript@latest` and
confirm `npm run lint`, `npx tsc --noEmit` and `npm run build` all pass.

**The side-by-side route** (install both, point typescript-eslint at the TS 6
API) was not taken: it means carrying two TypeScript installs and pinning the
tooling's resolution, which is a lot of standing complexity to buy a compiler
speedup this repo has not asked for. Worth revisiting only if `tsc` becomes a
bottleneck before upstream support lands.
