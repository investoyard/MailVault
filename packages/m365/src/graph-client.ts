import { ClientCertificateCredential, ClientSecretCredential, type TokenCredential } from '@azure/identity';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'https://graph.microsoft.com/.default';

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  certPath?: string; // PEM with private key + certificate (preferred)
  clientSecret?: string; // fallback for first tests only
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** Throttling, server busy and network-type errors are worth retrying. */
  get transient(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 504 || this.status === 0;
  }
}

export function graphConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphConfig {
  const tenantId = env.M365_TENANT_ID?.trim();
  const clientId = env.M365_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    throw new Error('M365_TENANT_ID and M365_CLIENT_ID must be set in .env (see docs/ENTRA-SETUP.md)');
  }
  const certPath = env.M365_CERT_PATH?.trim() || undefined;
  const clientSecret = env.M365_CLIENT_SECRET?.trim() || undefined;
  if (!certPath && !clientSecret) {
    throw new Error('Set M365_CERT_PATH (recommended) or M365_CLIENT_SECRET in .env');
  }
  return { tenantId, clientId, certPath, clientSecret };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Microsoft Graph client (app-only).
 * - Always asks for immutable IDs, so messages keep their ID when users move them.
 * - Honours Retry-After on 429/503 with exponential backoff + jitter.
 * - Returns raw Response for downloads so attachments can be streamed to disk.
 */
export class GraphClient {
  private readonly credential: TokenCredential;

  constructor(
    cfg: GraphConfig,
    private readonly maxRetries = 4,
  ) {
    this.credential = cfg.certPath
      ? new ClientCertificateCredential(cfg.tenantId, cfg.clientId, cfg.certPath)
      : new ClientSecretCredential(cfg.tenantId, cfg.clientId, cfg.clientSecret!);
  }

  async request(path: string, init: RequestInit & { prefer?: string[] } = {}): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.credential.getToken(SCOPE);
      if (!token) throw new GraphError('Could not acquire a Graph access token', 401);

      const prefer = ['IdType="ImmutableId"', ...(init.prefer ?? [])];
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${token.token}`, Prefer: prefer.join(', '), ...init.headers },
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw new GraphError(`Network error: ${(err as Error).message}`, 0);
        await sleep(this.backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const retryable = res.status === 429 || res.status === 503 || res.status === 504;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs(attempt));
        continue;
      }

      let code: string | undefined;
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        /* non-JSON error body */
      }
      throw new GraphError(message, res.status, code);
    }
  }

  async json<T>(path: string, init?: RequestInit & { prefer?: string[] }): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 1000 * 2 ** attempt);
    return base / 2 + Math.random() * (base / 2);
  }
}
