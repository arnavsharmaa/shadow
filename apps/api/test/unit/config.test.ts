import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { corsOrigins, loadConfig, repoRoot } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.SHADOW_API_HOST).toBe("127.0.0.1");
    expect(config.SHADOW_API_PORT).toBe(4000);
    expect(config.SHADOW_LOG_LEVEL).toBe("info");
    expect(config.SHADOW_AUTO_MIGRATE).toBe(true);
    expect(config.SHADOW_AUTO_SEED).toBe(true);
    expect(config.SHADOW_MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(config.SHADOW_REDACT_PATTERNS).toBe("");
    expect(config.NODE_ENV).toBe("development");
    expect(config.DATABASE_URL).toBeUndefined();
  });

  it("parses boolish flags", () => {
    for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
      expect(loadConfig({ SHADOW_AUTO_SEED: truthy }).SHADOW_AUTO_SEED, truthy).toBe(true);
    }
    for (const falsy of ["0", "false", "no", "off", ""]) {
      expect(loadConfig({ SHADOW_AUTO_MIGRATE: falsy }).SHADOW_AUTO_MIGRATE, falsy).toBe(false);
    }
  });

  it("coerces numeric values", () => {
    const config = loadConfig({ SHADOW_API_PORT: "8080", SHADOW_MAX_BODY_BYTES: "2048" });
    expect(config.SHADOW_API_PORT).toBe(8080);
    expect(config.SHADOW_MAX_BODY_BYTES).toBe(2048);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ SHADOW_API_PORT: "99999" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ SHADOW_API_PORT: "-1" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ SHADOW_API_PORT: "abc" })).toThrow(/SHADOW_API_PORT/);
  });

  it("rejects a body limit below 1KiB and an unknown log level", () => {
    expect(() => loadConfig({ SHADOW_MAX_BODY_BYTES: "10" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ SHADOW_LOG_LEVEL: "loud" })).toThrow(/SHADOW_LOG_LEVEL/);
  });

  it("resolves a relative SHADOW_DATA_DIR against the repo root", () => {
    const config = loadConfig({ SHADOW_DATA_DIR: "custom/data" });
    expect(path.isAbsolute(config.SHADOW_DATA_DIR)).toBe(true);
    expect(config.SHADOW_DATA_DIR).toBe(path.resolve(repoRoot(), "custom/data"));
  });

  it("keeps an absolute SHADOW_DATA_DIR unchanged", () => {
    const absolute = path.resolve("/tmp/shadow-data");
    expect(loadConfig({ SHADOW_DATA_DIR: absolute }).SHADOW_DATA_DIR).toBe(absolute);
  });

  it("ignores unrelated environment variables", () => {
    const config = loadConfig({ SOMETHING_ELSE: "x" });
    expect("SOMETHING_ELSE" in config).toBe(false);
  });
});

describe("repoRoot", () => {
  it("finds the workspace root from a nested directory", () => {
    const root = repoRoot(import.meta.dirname);
    // The checkout directory name differs between machines (e.g. CI clones
    // into lower-case `shadow`), so assert on the workspace marker instead.
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(root).toBe(repoRoot(path.join(root, "apps", "api")));
  });
});

describe("corsOrigins", () => {
  it("splits and trims the configured list", () => {
    const config = loadConfig({ SHADOW_CORS_ORIGINS: " http://a.test:3000, http://b.test ,, " });
    expect(corsOrigins(config)).toEqual(["http://a.test:3000", "http://b.test"]);
  });

  it("defaults to the local web origins", () => {
    expect(corsOrigins(loadConfig({}))).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });
});
