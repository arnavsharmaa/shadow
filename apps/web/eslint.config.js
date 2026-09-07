import { react } from "@shadow/config/eslint";
export default [
  ...react,
  {
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".next-e2e/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
];
