import type { JsonValue } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_PATTERNS,
  DEFAULT_REPLACEMENT,
  DEFAULT_VALUE_PATTERNS,
  createRedactor,
  defaultRedactor,
  parsePatternList,
} from "../src/index.js";

describe("default key patterns", () => {
  it("flag common secret-bearing keys regardless of case or separators", () => {
    for (const key of [
      "password",
      "PASSWD",
      "apiKey",
      "api_key",
      "API-KEY",
      "Authorization",
      "clientSecret",
      "client_secret",
      "accessToken",
      "Cookie",
      "set-cookie",
      "credentials",
      "privateKey",
      "private_key",
    ]) {
      expect(defaultRedactor.isSensitiveKey(key), key).toBe(true);
    }
  });

  it("leave ordinary keys alone", () => {
    for (const key of ["name", "email", "amount", "customerId", "message", "tokens"]) {
      // "tokens" matches /token/ by design; everything else must pass.
      if (key === "tokens") continue;
      expect(defaultRedactor.isSensitiveKey(key), key).toBe(false);
    }
    expect(DEFAULT_KEY_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe("default value patterns", () => {
  it("detect bearer tokens, API keys, GitHub/Slack/AWS credentials and private keys", () => {
    const secrets = [
      "Bearer abc.def-ghi_123",
      "bearer ABCDEF",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "xoxb-1234567890-abcdefgh",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB...",
    ];
    for (const value of secrets) expect(defaultRedactor.isSensitiveValue(value), value).toBe(true);
    expect(DEFAULT_VALUE_PATTERNS.length).toBe(6);
  });

  it("do not flag ordinary strings", () => {
    for (const value of ["hello", "sk-short", "Bearer", "order ord_5001 $480", "AKIA123"]) {
      expect(defaultRedactor.isSensitiveValue(value), value).toBe(false);
    }
  });
});

describe("createRedactor().redact", () => {
  it("replaces sensitive keys and values through nested objects and arrays", () => {
    const input: JsonValue = {
      user: {
        name: "Ana",
        password: "hunter2",
        tokens: ["sk-abcdefghijklmnopqrstuvwxyz", "plain"],
      },
      headers: [{ authorization: "Bearer xyz" }, { "x-trace": "keep" }],
      note: "Bearer abcdefghijklmnop",
      nested: { deeper: { apiKey: { still: "gone" } } },
      count: 3,
      flag: null,
    };
    expect(defaultRedactor.redact(input)).toEqual({
      user: { name: "Ana", password: DEFAULT_REPLACEMENT, tokens: DEFAULT_REPLACEMENT },
      headers: [{ authorization: DEFAULT_REPLACEMENT }, { "x-trace": "keep" }],
      note: DEFAULT_REPLACEMENT,
      nested: { deeper: { apiKey: DEFAULT_REPLACEMENT } },
      count: 3,
      flag: null,
    });
  });

  it("does not mutate the input and passes through primitives and undefined", () => {
    const input = { password: "x" };
    defaultRedactor.redact(input);
    expect(input).toEqual({ password: "x" });
    expect(defaultRedactor.redact(undefined)).toBeUndefined();
    expect(defaultRedactor.redact(null)).toBeNull();
    expect(defaultRedactor.redact(42)).toBe(42);
    expect(defaultRedactor.redact(true)).toBe(true);
    expect(defaultRedactor.redact("plain")).toBe("plain");
  });

  it("supports custom key/value patterns, additional patterns and a custom replacement", () => {
    const redactor = createRedactor({
      keyPatterns: [/^ssn$/i],
      valuePatterns: [/^\d{3}-\d{2}-\d{4}$/],
      additionalKeyPatterns: ["phone", /email/i],
      replacement: "***",
    });
    expect(
      redactor.redact({
        ssn: "1",
        SSN: "2",
        phone: "3",
        Email: "4",
        password: "stays",
        id: "123-45-6789",
        other: "ok",
      }),
    ).toEqual({
      ssn: "***",
      SSN: "***",
      phone: "***",
      Email: "***",
      password: "stays",
      id: "***",
      other: "ok",
    });
    expect(redactor.isSensitiveKey("PHONE")).toBe(true);
  });

  it("stops descending past a very deep nesting level", () => {
    let value: JsonValue = { password: "leaf" };
    for (let i = 0; i < 70; i++) value = { child: value };
    const result = defaultRedactor.redact(value);
    let cursor: JsonValue = result;
    for (let i = 0; i < 70; i++) cursor = (cursor as { child: JsonValue }).child;
    // Beyond the depth limit the subtree is returned as-is.
    expect(cursor).toEqual({ password: "leaf" });
  });
});

describe("parsePatternList", () => {
  it("parses comma-separated, case-insensitive patterns and ignores blanks", () => {
    const patterns = parsePatternList(" ssn , phone,,  ^x-internal ");
    expect(patterns).toHaveLength(3);
    expect(patterns.every((p) => p.flags.includes("i"))).toBe(true);
    expect(patterns.map((p) => p.source)).toEqual(["ssn", "phone", "^x-internal"]);
    expect(parsePatternList(undefined)).toEqual([]);
    expect(parsePatternList("")).toEqual([]);
  });
});
