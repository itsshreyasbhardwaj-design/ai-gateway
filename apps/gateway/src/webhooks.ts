import { newId } from '@ai-gateway/core';
import type { Store, WebhookDelivery, WebhookEventType } from '@ai-gateway/database';
import type { Logger } from '@ai-gateway/observability';
import { signWebhook, webhookRetryDelays, type SecretBox } from '@ai-gateway/security';

export interface WebhookPayload {
  event: WebhookEventType;
  organizationId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface WebhookDispatcherOptions {
  store: Store;
  secrets: SecretBox;
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * Webhook fan-out.
 *
 * Emitting is a database write, not an HTTP call: an alert must not be lost
 * because a customer's endpoint was slow, and a slow endpoint must not add
 * latency to the inference request that triggered it. The worker drains the
 * queue with signed, retried deliveries.
 */
export class WebhookDispatcher {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WebhookDispatcherOptions) {
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Queue an event for every endpoint in the org subscribed to it. */
  async emit(payload: WebhookPayload): Promise<number> {
    const endpoints = await this.opts.store.listWebhooks(payload.organizationId);
    const subscribed = endpoints.filter((w) => w.enabled && w.events.includes(payload.event));

    for (const endpoint of subscribed) {
      await this.opts.store.enqueueDelivery({
        id: newId('whk'),
        webhookId: endpoint.id,
        event: payload.event,
        payload,
        attempts: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
    return subscribed.length;
  }

  /** Drain due deliveries. Called on a timer by the worker. */
  async drain(
    limit = 25,
    now = new Date(),
  ): Promise<{ delivered: number; failed: number; retried: number }> {
    const due = await this.opts.store.claimPendingDeliveries(now, limit);
    let delivered = 0;
    let failed = 0;
    let retried = 0;

    for (const delivery of due) {
      const outcome = await this.deliver(delivery, now);
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'failed') failed++;
      else retried++;
    }
    return { delivered, failed, retried };
  }

  private async deliver(
    delivery: WebhookDelivery,
    now: Date,
  ): Promise<'delivered' | 'retry' | 'failed'> {
    const endpoints = await this.opts.store.listWebhooks(
      (delivery.payload as WebhookPayload).organizationId,
    );
    const endpoint = endpoints.find((e) => e.id === delivery.webhookId);
    if (!endpoint) {
      await this.opts.store.updateDelivery(delivery.id, {
        status: 'failed',
        lastError: 'endpoint no longer exists',
      });
      return 'failed';
    }

    const body = JSON.stringify(delivery.payload);
    const secret = this.opts.secrets.decrypt(endpoint.secretEncrypted);
    const timestamp = Math.floor(now.getTime() / 1000);
    const attempts = delivery.attempts + 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ai-gateway-webhooks/1',
          'x-aigw-event': delivery.event,
          'x-aigw-delivery': delivery.id,
          'x-aigw-signature': signWebhook(body, secret, timestamp),
        },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        await this.opts.store.updateDelivery(delivery.id, {
          status: 'delivered',
          attempts,
          deliveredAt: now.toISOString(),
        });
        await this.opts.store.upsertWebhook({
          ...endpoint,
          consecutiveFailures: 0,
          lastDeliveryAt: now.toISOString(),
          lastDeliveryStatus: response.status,
        });
        return 'delivered';
      }

      return this.scheduleRetry(
        delivery,
        attempts,
        `endpoint returned HTTP ${response.status}`,
        endpoint.id,
        now,
        response.status,
      );
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'delivery timed out'
          : 'could not reach endpoint';
      return this.scheduleRetry(delivery, attempts, message, endpoint.id, now);
    } finally {
      clearTimeout(timer);
    }
  }

  private async scheduleRetry(
    delivery: WebhookDelivery,
    attempts: number,
    error: string,
    webhookId: string,
    now: Date,
    status?: number,
  ): Promise<'retry' | 'failed'> {
    const endpoints = await this.opts.store.listWebhooks(
      (delivery.payload as WebhookPayload).organizationId,
    );
    const endpoint = endpoints.find((e) => e.id === webhookId);
    if (endpoint) {
      const consecutiveFailures = endpoint.consecutiveFailures + 1;
      await this.opts.store.upsertWebhook({
        ...endpoint,
        consecutiveFailures,
        lastDeliveryAt: now.toISOString(),
        lastDeliveryStatus: status ?? null,
        // Disable an endpoint that has been failing for a long time rather
        // than retrying it forever.
        enabled: consecutiveFailures < 50,
      });
    }

    if (attempts >= this.maxAttempts) {
      this.opts.logger.warn('webhook delivery exhausted retries', {
        deliveryId: delivery.id,
        attempts,
        error,
      });
      await this.opts.store.updateDelivery(delivery.id, {
        status: 'failed',
        attempts,
        lastError: error,
      });
      return 'failed';
    }

    const delays = webhookRetryDelays(this.maxAttempts);
    const delayMs = delays[attempts - 1] ?? 60_000;
    await this.opts.store.updateDelivery(delivery.id, {
      status: 'pending',
      attempts,
      lastError: error,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    });
    return 'retry';
  }
}
