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
];

export default eslintConfig;
