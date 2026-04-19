import {
  countPendingOutbound,
  getPendingOutbound,
  markOutboundAttemptFailed,
  markOutboundSent,
  OutboundRow,
} from './db.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

interface DispatcherDeps {
  getChannel: (chatJid: string) => Channel | null;
}

const POLL_INTERVAL_MS = 500;
const ABANDON_AFTER_ATTEMPTS = 10;
const DISPATCH_BATCH = 25;
/**
 * Per-row upper bound on a single sendMessage() call. Channels today
 * don't throw on transient failures (they queue internally and resolve),
 * so the realistic failure mode during shutdown is a hung transport.
 * Without this cap, one stuck send keeps drain() blocked past its
 * deadline and into systemd-kill territory.
 */
const SEND_TIMEOUT_MS = 5000;
/**
 * Once the queue first reads empty we wait one more quiet period before
 * declaring drain complete. queue.shutdown() only detaches containers;
 * their stdout can still produce fresh rows for a short window after
 * shutdown() returns, and we want those delivered in the same cycle.
 */
const DRAIN_QUIET_MS = 2000;

export class OutboundDispatcher {
  private deps: DispatcherDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private wakeImmediately = false;
  /**
   * When drain() is active it sets an absolute epoch-ms deadline here so
   * the row-level loop inside tick() can break out promptly. Without this,
   * a batch of 25 hung sends would spend up to 25 * SEND_TIMEOUT_MS before
   * the outer drain loop got a chance to re-check its own budget.
   */
  private drainDeadlineMs: number | null = null;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.scheduleTick(0);
  }

  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeImmediately = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.scheduleTick(0);
  }

  /**
   * Stop polling and resolve once the queue has been empty for a quiet
   * period, or the deadline elapses. Called from the host's SIGTERM
   * handler so pending rows get flushed before the channels disconnect.
   *
   * At-least-once semantics: `markOutboundSent` fires when the underlying
   * channel's `sendMessage()` promise resolves. Today most channels queue
   * internally and swallow transport errors, so a resolved send means
   * "handed to transport", not "delivered on the wire". A future contract
   * change that makes channels surface real delivery acks would tighten
   * this without touching the dispatcher logic.
   */
  async drain(deadlineMs: number): Promise<{ drained: boolean; remaining: number }> {
    const start = Date.now();
    this.drainDeadlineMs = start + deadlineMs;
    let emptySince: number | null = null;
    try {
      while (Date.now() - start < deadlineMs) {
        await this.tick();
        const remaining = countPendingOutbound();
        if (remaining === 0) {
          if (emptySince === null) emptySince = Date.now();
          if (Date.now() - emptySince >= DRAIN_QUIET_MS) {
            this.stop();
            return { drained: true, remaining: 0 };
          }
        } else {
          emptySince = null;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      this.stop();
      const remaining = countPendingOutbound();
      return { drained: remaining === 0, remaining };
    } finally {
      this.drainDeadlineMs = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().then(() => {
        const next = this.wakeImmediately ? 0 : POLL_INTERVAL_MS;
        this.wakeImmediately = false;
        this.scheduleTick(next);
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = getPendingOutbound(DISPATCH_BATCH);
      for (const row of rows) {
        if (this.stopped) break;
        if (
          this.drainDeadlineMs !== null &&
          Date.now() >= this.drainDeadlineMs
        ) {
          // Drain budget spent mid-batch; stop so the outer loop can exit.
          // Without this, a batch of hung sends would block drain() long
          // past its deadline (Codex finding: 25 rows * SEND_TIMEOUT_MS
          // worst case).
          break;
        }
        await this.deliverOne(row);
      }
    } catch (err) {
      logger.error({ err }, 'outbound-dispatcher: tick failed');
    } finally {
      this.running = false;
    }
  }

  private async deliverOne(row: OutboundRow): Promise<void> {
    const channel = this.deps.getChannel(row.chat_jid);
    if (!channel) {
      // `findChannel` looks up by JID prefix and returns undefined only
      // for truly unrouted JIDs; a disconnected-but-present channel will
      // still be returned and the send will throw/timeout instead. Leave
      // the row pending without bumping attempts — nothing was tried.
      return;
    }
    // Per-row budget: cap at SEND_TIMEOUT_MS, but shorten further if the
    // drain deadline is closer so we don't overrun shutdown.
    let budget = SEND_TIMEOUT_MS;
    if (this.drainDeadlineMs !== null) {
      budget = Math.max(
        100,
        Math.min(SEND_TIMEOUT_MS, this.drainDeadlineMs - Date.now()),
      );
    }
    try {
      const sendPromise = channel.sendMessageWithReceipt
        ? channel.sendMessageWithReceipt(
            row.chat_jid,
            row.text,
            row.sender_label ?? undefined,
            { outboundMessageId: row.id },
          )
        : channel
            .sendMessage(row.chat_jid, row.text, row.sender_label ?? undefined)
            .then(() => undefined);
      const receipt = await withTimeout(
        sendPromise,
        budget,
        'sendMessage timed out',
      );
      markOutboundSent(row.id, receipt ?? undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const result = markOutboundAttemptFailed(row.id, msg, ABANDON_AFTER_ATTEMPTS);
      if (result.abandoned) {
        logger.error(
          { id: row.id, chatJid: row.chat_jid, attempts: result.attempts, err: msg },
          'outbound-dispatcher: abandoning after max attempts',
        );
      } else {
        logger.warn(
          { id: row.id, chatJid: row.chat_jid, attempts: result.attempts, err: msg },
          'outbound-dispatcher: delivery failed, will retry',
        );
      }
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
