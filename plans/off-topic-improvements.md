# Off-topic improvements

Things noticed while working on something else. Out of scope where they were
found; worth doing on their own.

## E2E: edit-mode suite is flaky under parallel load

About two runs in five, one edit-mode test fails on a timeout under the
7-worker chromium run — a different test each time ("Can mark a bank as
emergency", "Can rename pads in edit mode", "opens edit modal on Shift+click",
"Armed track is visually indicated on the pad").

Measured on `d3ccd34` with none of the server-sync branch's code, so it is not
a regression from that work: baseline flaked 2/5, the feature branch 2/5.
Run times also vary widely (30 s to 1.2 min) on the same machine, which points
at contention rather than a specific test.

The `playwright.config.ts` comment claims "production: 39 passed / 0 flaky",
so this may have regressed since, or only appears on a busy machine. Worth
either fixing the underlying race or reducing worker count for that file.

## `next.config.ts`: workspace root inferred wrongly

Every build warns:

```
Warning: Next.js inferred your workspace root, but it may not be correct.
We detected multiple lockfiles and selected the directory of
/home/mick/package-lock.json as the root directory.
```

A stray `~/package-lock.json` makes Next pick the home directory as the
tracing root, which is why `output: standalone` writes its server to
`.next/standalone/Stack/Programmeren/impamp-2/...` instead of
`.next/standalone/server.js`. Setting `outputFileTracingRoot` in
`next.config.ts` would pin it and make the documented
`node .next/standalone/server.js` start command work as written.

## `npm start` contradicts `output: standalone`

`next start` prints:

```
⚠ "next start" does not work with "output: standalone" configuration.
```

It does currently serve, but the Playwright config and `npm start` both rely
on a combination Next says is unsupported. Should either drop `standalone`
(the Dockerfile depends on it) or point both at the standalone server.

## `useProfileStore` subscriptions in `ClientSideInitializer`

The component now holds four separate `useProfileStore.subscribe` callbacks
(auth, sync queue, edit mode, server-sync streams), each firing on _every_
store mutation and filtering afterwards. Consolidating them, or using
selector-based subscriptions, would cut redundant work on every state change.
