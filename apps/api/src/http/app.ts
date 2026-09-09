import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { LogController } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import { ZodError, z } from "zod";
import { corsOrigins, type ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { branchRoutes } from "./routes/branches.js";
import { comparisonRoutes } from "./routes/comparisons.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { traceRoutes } from "./routes/traces.js";

export const API_VERSION = "0.1.0";

declare module "fastify" {
  interface FastifyInstance {
    services: ServiceContext;
    apiConfig: ApiConfig;
  }
}

export interface BuildAppOptions {
  config: ApiConfig;
  services: ServiceContext;
  logger: Logger;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    bodyLimit: options.config.SHADOW_MAX_BODY_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => `req_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    // Request logging is handled by the onResponse hook below (one structured
    // line per request with the request id and duration).
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
  });
  app.decorate("services", options.services);
  app.decorate("apiConfig", options.config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });

  await app.register(cors, {
    origin: corsOrigins(options.config),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Shadow API",
        description:
          "Time-travel debugging for AI agents: trace ingestion, state reconstruction, forks, deterministic replay and branch comparison.",
        version: API_VERSION,
        license: { name: "Apache-2.0" },
      },
      tags: [
        { name: "health" },
        { name: "projects" },
        { name: "traces" },
        { name: "events" },
        { name: "branches" },
        { name: "forks" },
        { name: "replays" },
        { name: "comparisons" },
        { name: "artifacts" },
        { name: "transfer" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "not_found",
        message: `route ${request.method} ${request.url} does not exist`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    if (error instanceof ApiError) {
      if (error.status >= 500) request.log.error({ err: error, requestId }, error.message);
      reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details, requestId },
      });
      return;
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: {
          code: "validation_error",
          message: "request validation failed",
          details: error.validation.map((v) => ({
            path: v.instancePath,
            message: v.message,
            params: v.params,
          })),
          requestId,
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "validation_error",
          message: z.prettifyError(error),
          details: error.issues,
          requestId,
        },
      });
      return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, requestId }, "response serialization failed");
      reply.status(500).send({
        error: {
          code: "serialization_error",
          message: "response did not match its schema",
          requestId,
        },
      });
      return;
    }
    const fastifyError = error as { code?: string; statusCode?: number; message?: string };
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.status(413).send({
        error: {
          code: "payload_too_large",
          message: `request body exceeds ${options.config.SHADOW_MAX_BODY_BYTES} bytes`,
          requestId,
        },
      });
      return;
    }
    if (
      fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ||
      fastifyError.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    ) {
      reply.status(415).send({
        error: {
          code: "unsupported_media_type",
          message: fastifyError.message ?? "unsupported media type",
          requestId,
        },
      });
      return;
    }
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      reply.status(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? "bad_request",
          message: fastifyError.message ?? "bad request",
          requestId,
        },
      });
      return;
    }
    request.log.error({ err: error, requestId, url: request.url }, "unhandled error");
    reply
      .status(500)
      .send({ error: { code: "internal_error", message: "internal server error", requestId } });
  });

  await app.register(healthRoutes);
  await app.register(projectRoutes, { prefix: "/api/v1" });
  await app.register(traceRoutes, { prefix: "/api/v1" });
  await app.register(branchRoutes, { prefix: "/api/v1" });
  await app.register(comparisonRoutes, { prefix: "/api/v1" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  return app;
}

export type ShadowApp = Awaited<ReturnType<typeof buildApp>>;
