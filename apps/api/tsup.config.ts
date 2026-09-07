import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts", "src/db/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Bundle workspace packages; keep real dependencies external.
  noExternal: ["@shadow/core", "@shadow/schemas", "@shadow/testkit"],
  publicDir: false,
});
