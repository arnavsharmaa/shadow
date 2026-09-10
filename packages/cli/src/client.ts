export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  connection: 3,
  notFound: 4,
} as const;

export interface ApiClientOptions {
  endpoint: string;
  fetch?: typeof fetch;
  /** Bearer token for APIs started with SHADOW_API_TOKEN. */
  token?: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

/** Thin HTTP client for the Shadow API used by every command. */
export class ApiClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;

  constructor(options: ApiClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.token = options.token;
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return this.request<T>("GET", url.toString());
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", `${this.endpoint}${path}`, body);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(
        `could not reach the Shadow API at ${this.endpoint} (${error instanceof Error ? error.message : String(error)}). Is it running? Try \`pnpm dev\` or set --endpoint.`,
        EXIT.connection,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const envelope = (parsed ?? {}) as ErrorEnvelope;
      const message =
        response.status === 401
          ? "the API requires a bearer token: pass --token or set SHADOW_TOKEN"
          : (envelope.error?.message ?? `request failed with status ${response.status}`);
      const details = envelope.error?.details
        ? `\n${JSON.stringify(envelope.error.details, null, 2)}`
        : "";
      throw new CliError(
        `${message}${details}`,
        response.status === 404 ? EXIT.notFound : EXIT.error,
      );
    }
    return parsed as T;
  }
}
