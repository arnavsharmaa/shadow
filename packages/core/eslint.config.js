import { base, forbidImports } from "@shadow/config/eslint";
export default [
  ...base,
  forbidImports(
    ["next", "react", "react-dom", "fastify", "drizzle-orm", "pg"],
    "@shadow/core contains business logic only and must not depend on frameworks.",
  ),
];
