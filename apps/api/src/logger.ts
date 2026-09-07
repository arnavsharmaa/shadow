import { createRedactor, parsePatternList } from "@shadow/core";
import pino, { type Logger } from "pino";

export interface LoggerOptions {
  level: string;
  pretty?: boolean;
  redactPatterns?: string;
}

/** Structured JSON logger. Sensitive keys are redacted before they are written. */
export function createLogger(options: LoggerOptions): Logger {
  const redactor = createRedactor({
    additionalKeyPatterns: parsePatternList(options.redactPatterns),
  });
  return pino({
    level: options.level,
    base: { service: "shadow-api" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.apiKey",
        "*.token",
        "*.secret",
      ],
      censor: "[REDACTED]",
    },
    formatters: {
      log(object) {
        return redactor.redact(JSON.parse(JSON.stringify(object)));
      },
    },
    ...(options.pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname,service",
            },
          },
        }
      : {}),
  });
}

export type { Logger };
