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
      ".worktrees/**",
      "playwright-report/**",
      "test-results/**",
      "src/generated/**",
      "public/sw.js",
      "public/workbox-*.js",
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
    // eslint-config-next 16 turns on the React Compiler-era react-hooks rules,
    // which flagged long-standing patterns across this codebase. They were all
    // demoted to warnings at the time so CI stayed green on pre-existing code.
    //
    // immutability, refs and purity are cleared and back to "error" — the
    // remaining set-state-in-effect sites are still being worked through, and
    // it stays a warning until the last one goes.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
