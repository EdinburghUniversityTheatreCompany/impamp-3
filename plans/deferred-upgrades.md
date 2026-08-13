# Deferred upgrades

Dependency bumps that were attempted, could not be landed green, and were
reverted. Each entry records what blocked it and what has to be true to retry.

## file-selector 5.0.0 — held deliberately at 4.1.0 (2026-08-13)

Not a failure; a deliberate pin. `file-selector` is a direct dependency only so
`Pad.tsx` can import `COMMON_MIME_TYPES` from its `/mime` subpath (see the
react-dropzone 20 commit). react-dropzone 20.1.0 depends on
`file-selector: ^4.1.0`, so taking 5.0.0 at the top level would install a
second copy — and `fromEvent` would then come from a different build than the
one react-dropzone calls internally.

**Retry when** react-dropzone widens its range to file-selector 5. Match its
range then, rather than leading it; `npm ls file-selector` should always show a
single deduped entry.

## eslint 10.8.1 — blocked on eslint-plugin-react (2026-08-13)

**Landed instead:** nothing; held at eslint 9.39.5.

ESLint 10 dropped a rule-context API that `eslint-plugin-react` still calls, so
every lint run dies before reporting anything:

```
ESLint: 10.8.1
TypeError: Error while loading rule 'react/display-name':
  contextOrFilename.getFilename is not a function
    at resolveBasedir (node_modules/eslint-config-next/node_modules/eslint-plugin-react/lib/util/version.js:31:100)
```

There is no version to upgrade _to_: `eslint-plugin-react@7.37.5` is the latest
release and its peer range ends at `^9.7`, so it never claims ESLint 10
support. It arrives here as a transitive dependency of `eslint-config-next`
(`eslint-plugin-react: ^7.37.0`), so pinning it forward is not an option
either.

Upstream tracking: https://github.com/jsx-eslint/eslint-plugin-react/issues/3977
("ESLint v10 compatibility", open, last updated 2026-07-30). A `7.8.0-rc.0`
sits on the `next` dist-tag but is a prerelease and not what
`eslint-config-next` resolves.

**Retry when** eslint-plugin-react ships a stable release declaring ESLint 10
in its peer range and `eslint-config-next` picks it up. Then
`npm install --save-dev eslint@latest` and confirm `npm run lint` runs to
completion.

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
