/**
 * In-process job runner for long operations such as large batch counterfactuals. Jobs run one
 * at a time in submission order, so a big batch never competes with interactive replays for
 * more than one slot. State that must survive the process lives in the database; the runner
 * only tracks what is executing here.
 */
export interface JobControl {
  /** True once `cancel(jobId)` (or `stop()`) was called; tasks check it between steps. */
  cancelled(): boolean;
}

export interface JobRunner {
  enqueue(jobId: string, task: (control: JobControl) => Promise<void>): void;
  /** Ask a queued or running job to stop; returns false when the runner does not know it. */
  cancel(jobId: string): boolean;
  /** Resolve once every queued and running job has finished. */
  settle(): Promise<void>;
  /** Cancel everything and wait (used on shutdown). */
  stop(): Promise<void>;
}

export function createJobRunner(
  onError: (jobId: string, error: unknown) => void = () => {},
): JobRunner {
  const cancelled = new Set<string>();
  const known = new Set<string>();
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue(jobId, task) {
      known.add(jobId);
      const control: JobControl = { cancelled: () => cancelled.has(jobId) };
      tail = tail
        .then(() => task(control))
        .catch((error: unknown) => onError(jobId, error))
        .finally(() => {
          known.delete(jobId);
          cancelled.delete(jobId);
        });
    },
    cancel(jobId) {
      if (!known.has(jobId)) return false;
      cancelled.add(jobId);
      return true;
    },
    async settle() {
      await tail;
    },
    async stop() {
      for (const jobId of known) cancelled.add(jobId);
      await tail;
    },
  };
}
