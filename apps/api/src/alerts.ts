import type { Logger } from "pino";
import type { ApiConfig } from "./config.js";
import { evaluateAlertRules, type AlertEvaluation } from "./services/alerts.js";
import type { ServiceContext } from "./services/context.js";

export interface AlertEvaluator {
  enabled: boolean;
  runOnce(): Promise<AlertEvaluation[]>;
  start(): void;
  stop(): void;
}

/**
 * Evaluates alert rules every SHADOW_ALERT_INTERVAL_MINUTES (0 disables the timer; rules can
 * still be checked on demand through the API). Evaluations never overlap.
 */
export function createAlertEvaluator(input: {
  services: ServiceContext;
  config: Pick<ApiConfig, "SHADOW_ALERT_INTERVAL_MINUTES">;
  logger: Logger;
}): AlertEvaluator {
  const { services, config, logger } = input;
  const minutes = config.SHADOW_ALERT_INTERVAL_MINUTES;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<AlertEvaluation[]> | null = null;

  const runOnce = (): Promise<AlertEvaluation[]> => {
    running ??= evaluateAlertRules(services).finally(() => {
      running = null;
    });
    return running;
  };

  return {
    enabled: minutes > 0,
    runOnce,
    start() {
      if (minutes <= 0 || timer) return;
      const tick = () => {
        runOnce().catch((error: unknown) => {
          logger.error({ err: error }, "alert evaluation failed");
        });
      };
      timer = setInterval(tick, minutes * 60_000);
      timer.unref();
      logger.info({ intervalMinutes: minutes }, "alert evaluation enabled");
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
