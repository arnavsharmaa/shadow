import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";

describe("ApiError", () => {
  it("is a real Error with status, code and details", () => {
    const error = new ApiError(418, "teapot", "short and stout", { size: "small" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(418);
    expect(error.code).toBe("teapot");
    expect(error.message).toBe("short and stout");
    expect(error.details).toEqual({ size: "small" });
    expect(error.stack).toContain("short and stout");
  });

  it("builds not-found errors", () => {
    const error = ApiError.notFound("trace", "trc_x");
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("trace trc_x was not found");
    expect(error.details).toEqual({ resource: "trace", id: "trc_x" });
  });

  it("builds bad-request errors", () => {
    const error = ApiError.badRequest("nope", [{ path: "x" }]);
    expect(error.status).toBe(400);
    expect(error.code).toBe("bad_request");
    expect(error.details).toEqual([{ path: "x" }]);
    expect(ApiError.badRequest("no details").details).toBeUndefined();
  });

  it("builds conflict errors", () => {
    const error = ApiError.conflict("exists", { traceId: "trc_1" });
    expect(error.status).toBe(409);
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ traceId: "trc_1" });
  });

  it("builds unprocessable errors with a custom code", () => {
    const error = ApiError.unprocessable("not_forked", "fork first", { branchId: "br_1" });
    expect(error.status).toBe(422);
    expect(error.code).toBe("not_forked");
    expect(error.message).toBe("fork first");
    expect(error.details).toEqual({ branchId: "br_1" });
  });
});
