import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  // `next lint` used to supply these ignores implicitly. Next 16 removed that
  // command, so the npm script now calls eslint directly and the build output
  // has to be excluded here — otherwise a lint run reports thousands of
  // problems in generated .next/ chunks and drowns the handful of real ones.
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
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
  // load them — it tries to JSON.stringify the config for eslintrc schema
  // validation and dies on the circular `plugins.react` reference.
  ...nextCoreWebVitals,
  ...nextTypeScript,
];

export default eslintConfig;
