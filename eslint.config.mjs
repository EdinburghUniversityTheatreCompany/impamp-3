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
    // Wallaby.js reads this file itself, as CommonJS — require() is the only
    // form it accepts, so the TS import rules don't apply.
    files: ["wallaby.config.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // eslint-config-next 16 turns on the React Compiler-era react-hooks rules.
    // They flag long-standing patterns in this codebase — set-state-in-effect
    // being most of them — none of which the dependency upgrade introduced.
    // Clearing them means reworking effect-driven state in the audio, profile
    // and sync paths: a real refactor with real regression risk, and not
    // something to bundle into a dependency bump.
    //
    // Demoted to warnings so they stay visible without turning CI red on
    // pre-existing code. The sites are catalogued in
    // plans/off-topic-improvements.md; promote each back to "error" as it is
    // cleared.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
];

export default eslintConfig;
