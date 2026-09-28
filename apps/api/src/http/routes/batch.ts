import { batchCounterfactualBodySchema, batchJobListQuerySchema, idSchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  cancelBatchJob,
  getBatchJob,
  listBatchJobs,
  runBatchCounterfactual,
  startBatchJob,
} from "../../services/batch.js";
import { audit } from "../audit.js";

const jobParams = z.object({ jobId: idSchema });

export const batchRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Apply one override set to many recorded traces of an agent (see docs/architecture/api.md). */
  app.post(
    "/batch/counterfactuals",
    { schema: { tags: ["forks"], body: batchCounterfactualBodySchema } },
    async (request, reply) => {
      if (request.body.background) {
        const job = await startBatchJob(app.services, request.body);
        await audit(app, request, {
          action: "batch.queued",
          targetType: "job",
          targetId: job.id,
          details: { agent: request.body.agent, at: request.body.at, limit: request.body.limit },
        });
        reply.header("location", `/api/v1/batch/jobs/${job.id}`);
        return reply.status(202).send(job);
      }
      const result = await runBatchCounterfactual(app.services, request.body);
      await audit(app, request, {
        action: "batch.run",
        targetType: "trace",
        targetId: "*",
        details: {
          agent: request.body.agent,
          at: request.body.at,
          summary: result.summary,
          branches: result.results.flatMap((r) => (r.status === "ok" ? [r.branch.id] : [])),
        },
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/batch/jobs",
    { schema: { tags: ["forks"], querystring: batchJobListQuerySchema } },
    async (request) => ({ items: await listBatchJobs(app.services, request.query) }),
  );

  app.get(
    "/batch/jobs/:jobId",
    { schema: { tags: ["forks"], params: jobParams } },
    async (request) => getBatchJob(app.services, request.params.jobId),
  );

  app.post(
    "/batch/jobs/:jobId/cancel",
    { schema: { tags: ["forks"], params: jobParams } },
    async (request) => {
      const job = await cancelBatchJob(app.services, request.params.jobId);
      await audit(app, request, {
        action: "batch.cancelled",
        targetType: "job",
        targetId: job.id,
        details: { status: job.status, progress: job.progress },
      });
      return job;
    },
  );
};
