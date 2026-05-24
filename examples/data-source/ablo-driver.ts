/**
 * Ablo-Cloud-side request driver.
 *
 * This file is what Ablo Cloud runs in production. Customers DON'T
 * write it — they only see signed POSTs hit their endpoint. We
 * publish it here so the example can show the full round-trip
 * locally without standing up the cloud.
 *
 * In production:
 *   - Ablo Cloud holds the signing secret in its config
 *   - It signs each outbound POST with `signAbloSourceRequest`
 *   - The customer's `dataSource(...)` handler verifies the signature
 *   - The response feeds back into Ablo Cloud's hosted realtime layer
 *
 * Here we wire signer -> in-process handler with no network hop, so
 * `npx tsx run.ts` works without ports, env, or cloud credentials.
 */

import {
  signAbloSourceRequest,
  type Ablo,
} from '@ablo/sync-engine';

export interface AbloDriverOptions {
  /**
   * In-process target. Production calls a URL; the example calls
   * the handler directly so there's no http port to manage.
   */
  readonly handler: (request: Request) => Promise<Response>;
  /** Same secret the customer's `dataSource(...)` is configured with. */
  readonly signingSecret: string;
}

export class AbloDriver {
  private messageCounter = 0;

  constructor(private readonly options: AbloDriverOptions) {}

  async load(model: string, id: string): Promise<unknown> {
    return this.send({ type: 'load', model, id });
  }

  async list(model: string, query?: Ablo.Source.Operation['input']) {
    return this.send({ type: 'list', model, query: query ?? {} });
  }

  async commit(operations: readonly Ablo.Source.Operation[], clientTxId?: string) {
    return this.send({
      type: 'commit',
      operations,
      ...(clientTxId ? { clientTxId } : {}),
    });
  }

  async events(cursor?: string, limit?: number) {
    return this.send({
      type: 'events',
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  // Builds the exact signed Request shape the production Ablo Cloud
  // would send. The customer's handler can't tell this apart from a
  // real cloud-originated request.
  private async send(payload: Record<string, unknown>): Promise<unknown> {
    this.messageCounter += 1;
    const body = JSON.stringify(payload);
    const messageId = `msg_${Date.now()}_${this.messageCounter}`;
    const signed = await signAbloSourceRequest({
      secret: this.options.signingSecret,
      body,
      messageId,
    });
    const request = new Request('http://example.test/api/ablo/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signed.headers },
      body,
    });
    const response = await this.options.handler(request);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Data Source POST ${payload.type} failed: ${response.status} ${text}`,
      );
    }
    return response.json();
  }
}
