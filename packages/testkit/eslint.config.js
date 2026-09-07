import { base, forbidImports } from "@shadow/config/eslint";
export default [
  ...base,
  forbidImports(["next", "react", "fastify"], "@shadow/testkit must stay framework-free."),
];
