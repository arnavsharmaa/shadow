// Shared ESLint (flat config) preset for the Shadow monorepo.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Files every package ignores. */
export const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.next-e2e/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/drizzle/**",
  "**/*.d.ts",
];

/**
 * Base rules for TypeScript source.
 * @type {import("eslint").Linter.Config[]}
 */
export const base = [
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      "no-console": "off",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  prettier,
];

/**
 * Rules for React / Next.js code.
 * @type {import("eslint").Linter.Config[]}
 */
export const react = [
  ...base,
  {
    files: ["**/*.tsx", "**/*.jsx"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
];

/**
 * Package-boundary rule: forbid importing the named modules.
 * @param {string[]} forbidden
 * @param {string} message
 * @returns {import("eslint").Linter.Config}
 */
export function forbidImports(forbidden, message) {
  return {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: forbidden.map((name) => ({ name, message })),
          patterns: forbidden.map((name) => ({ group: [`${name}/*`], message })),
        },
      ],
    },
  };
}
