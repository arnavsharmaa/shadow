import { fnv1a } from "@shadow/core";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

/**
 * Server-side sampling on ingestion. The decision is a deterministic function of the trace id,
 * the same one the SDK uses for `sampleRate`, so retries of a run decide the same way and a
 * client and server sampling at the same rate keep the same traces rather than thinning twice.
 * Sampled-out traces are never stored; their requests are acknowledged with `202` so callers
 * do not retry. A request may force a trace through with `x-shadow-sample: keep`.
 */
export interface Sampler {
  enabled: boolean;
  rate: number;
  /** True when a trace with this id is kept (or sampling is off). */
  keeps(traceId: string): boolean;
}

export function hashToUnit(value: string): number {
  return fnv1a(value) / 0x100000000;
}

export function createSampler(rate: number): Sampler {
  const enabled = rate < 1;
  return {
    enabled,
    rate,
    keeps: (traceId) => !enabled || (rate > 0 && hashToUnit(traceId) < rate),
  };
}

export function forcedKeep(request: FastifyRequest): boolean {
  const header = request.headers["x-shadow-sample"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim().toLowerCase() === "keep";
}

/**
 * Whether a request about `traceId` should be acknowledged without doing anything: the id is
 * sampled out and no trace with it exists (one created before sampling was enabled, or forced
 * through, is always served). Called after the normal lookup has failed with `404`.
 */
export function sampledOut(sampler: Sampler, request: FastifyRequest, traceId: string): boolean {
  return sampler.enabled && !forcedKeep(request) && !sampler.keeps(traceId);
}

/** Run `action`; when it fails with `404` for a sampled-out trace, answer `202` instead. */
export async function unlessSampledOut<T>(
  sampler: Sampler,
  request: FastifyRequest,
  traceId: string,
  action: () => Promise<T>,
): Promise<{ sampled: true; value: T } | { sampled: false }> {
  try {
    return { sampled: true, value: await action() };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      sampledOut(sampler, request, traceId)
    ) {
      return { sampled: false };
    }
    throw error;
  }
}
