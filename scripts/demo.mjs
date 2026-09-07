#!/usr/bin/env node
// Runs the canonical demo: migrate + seed the deterministic demo data, then
// start the API and web app. Works without Docker (embedded PGlite) unless
// DATABASE_URL points at PostgreSQL.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { cwd: root, stdio: "inherit", env: process.env, ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`)),
    );
    child.on("error", reject);
  });
}

if (!existsSync(path.join(root, "node_modules"))) {
  console.log("[shadow demo] installing dependencies");
  await run(["install"]);
}
console.log("[shadow demo] applying migrations and seeding demo data");
await run(["--filter", "@shadow/api", "db:seed"]);
console.log(`
[shadow demo] starting Shadow

  web   http://localhost:3000
  api   http://localhost:4000  (OpenAPI at /docs)

  60-second tour:
   1. Open http://localhost:3000 and click "refund-request: defective headphones".
   2. Select the refund_order tool.request; read the state inspector (refundLimit = 500).
   3. Press "Fork from here", set context refundLimit to 100, run the counterfactual.
   4. Compare: the policy evaluation is the first divergence; the fork requests approval.
`);
await run(["dev"]);
