#!/usr/bin/env node
// Regenerate apps/api/src/otlp/proto/trace-descriptor.ts from the pinned
// opentelemetry-proto release. Run from the repository root:
//   node scripts/otlp-descriptor.mjs
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const VERSION = "v1.5.0";
const FILES = [
  "common/v1/common.proto",
  "resource/v1/resource.proto",
  "trace/v1/trace.proto",
  "collector/trace/v1/trace_service.proto",
];
const BASE = `https://raw.githubusercontent.com/open-telemetry/opentelemetry-proto/${VERSION}/opentelemetry/proto`;

const require = createRequire(path.resolve("apps/api/package.json"));
const protobuf = require("protobufjs");

const dir = await mkdtemp(path.join(tmpdir(), "otlp-proto-"));
for (const file of FILES) {
  const response = await fetch(`${BASE}/${file}`);
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const target = path.join(dir, "opentelemetry/proto", file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await response.text());
}
const root = new protobuf.Root();
root.resolvePath = (origin, target) =>
  target.startsWith("opentelemetry/")
    ? path.join(dir, target)
    : protobuf.util.path.resolve(origin, target);
await root.load(path.join(dir, "opentelemetry/proto/collector/trace/v1/trace_service.proto"), {
  keepCase: false,
});
const out = path.resolve("apps/api/src/otlp/proto/trace-descriptor.ts");
await writeFile(
  out,
  `// Generated from opentelemetry-proto ${VERSION} (trace_service.proto and its imports)\n` +
    "// with protobufjs Root#toJSON via scripts/otlp-descriptor.mjs. Do not edit by hand.\n" +
    `export const otlpTraceDescriptor = ${JSON.stringify(root.toJSON())} as const;\n`,
);
console.log(`wrote ${out}`);
