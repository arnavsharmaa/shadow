import { base, forbidImports } from "@shadow/config/eslint";
export default [
  ...base,
  forbidImports(
    ["next", "react", "fastify", "drizzle-orm"],
    "@shadow/cli is a thin client over the HTTP API.",
  ),
];
