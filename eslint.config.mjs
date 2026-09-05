import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // `next lint` used to exclude these implicitly; `eslint .` does not, and
    // linting build output produces thousands of meaningless errors.
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      // Both spellings: `.worktrees/` is the manual convention, and
      // `.claude/worktrees/` is where the agent tooling puts them. Each holds a
      // full checkout plus its own node_modules, so missing one turns
      // `npm run lint` into tens of thousands of problems from other people's
      // dependencies and hides the handful that are actually yours.
      ".worktrees/**",
      ".claude/worktrees/**",
      "playwright-report/**",
      "test-results/**",
      "src/generated/**",
      "next-env.d.ts",
    ],
  },
  // eslint-config-next 16 ships flat configs on its subpaths, so these are
  // spread straight in. The old FlatCompat bridge (@eslint/eslintrc) cannot
  // load them — it runs the config through eslintrc schema validation, which
  // JSON.stringify's it and dies on the circular `plugins.react` reference.
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // The `_name` convention was already in use for deliberately-unused
      // parameters — a `fetch` stub has to accept the arguments it ignores to
      // match the signature — but nothing told ESLint that, so those files
      // carried permanent warnings. `npm run lint` exits 0 on warnings, so
      // they were invisible in CI and just accumulated.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // A native alert halts the page's JavaScript until it is dismissed, so
      // while one is up ESC cannot stop a sound and Fade Out All cannot fade
      // one. Seventeen of them were the app's whole failure surface until
      // 2026-09; failures go through `noticeActions` / `reportFailure` in
      // `src/store/noticeStore.ts` now. `confirm` and `prompt` are not named
      // here on purpose — both are still in use, and blocking the page to ask
      // a question the operator chose to be asked is a different thing from
      // blocking it to report a failure they did not.
      "no-restricted-globals": [
        "error",
        {
          name: "alert",
          message:
            "Blocks the page, and with it ESC and Fade Out All. Use reportFailure / noticeActions.error from src/store/noticeStore.ts.",
        },
      ],
    },
  },
];

export default eslintConfig;
