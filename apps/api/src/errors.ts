/** Error carrying an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static notFound(resource: string, id: string): ApiError {
    return new ApiError(404, "not_found", `${resource} ${id} was not found`, { resource, id });
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "bad_request", message, details);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, "conflict", message, details);
  }

  static unprocessable(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(422, code, message, details);
  }
}
