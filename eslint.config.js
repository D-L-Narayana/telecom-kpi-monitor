/**
 * ESLint flat configuration.
 *
 * - JavaScript recommended rules plus the typescript-eslint recommended set (syntactic only — no type
 *   information, so linting stays fast and does not depend on a tsconfig project).
 * - React hooks rules and jsx-a11y recommended rules for the application sources under src/.
 * - Globals: browser for src/, node for scripts and tool configs, both for unit tests and e2e specs.
 * - Generated and report directories are ignored; data/ holds generated artefacts, not code.
 */
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["node_modules/", "dist/", "coverage/", "playwright-report/", "test-results/", "blob-report/", "data/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    name: "project/unused-vars",
    rules: {
      // Underscore-prefixed names mark intentionally unused parameters, variables and caught errors.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    name: "project/app-sources",
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Scrollable content regions (e.g. a wide table inside an overflow container) must be reachable from the
      // keyboard (WCAG 2.1.1; axe rule `scrollable-region-focusable`). The documented remedy is tabindex="0" on the
      // scroll container together with role="region" and an accessible name, so `region` joins the roles that may
      // carry a tabindex; everything else in the recommended rule stays as is.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: [], roles: ["tabpanel", "region"], allowExpressionValues: true }],
    },
  },
  {
    name: "project/unit-tests",
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    name: "project/e2e-specs",
    files: ["e2e/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    name: "project/node-scripts-and-configs",
    files: ["scripts/**/*.{js,mjs,cjs}", "*.config.{js,mjs,cjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },
]);
