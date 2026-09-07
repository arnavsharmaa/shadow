import { base, forbidImports } from "@shadow/config/eslint";
export default [
  ...base,
  forbidImports(
    ["@shadow/core", "@shadow/api", "@shadow/web", "next", "react", "fastify", "drizzle-orm"],
    "@shadow/sdk must stay dependency-light and independent from application internals.",
  ),
];
