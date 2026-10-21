import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadNativeConfig } from './config';
import { BridgeStore } from './store';
import { connectDiscordIngestion } from './discord-ingestion';
import { DiscordPosting } from './discord-posting';
import { NativeKindroid } from './kindroid';
import { DeliveryLoop, systemClock } from './delivery';

export async function runNative(): Promise<void> {
  const config = loadNativeConfig(process.env);
  const token = process.env.DISCORD_BOT_TOKEN;
  const key = process.env.KINDROID_API_KEY;
  if (!token?.trim()) throw new Error('DISCORD_BOT_TOKEN is required');
  if (!key?.trim()) throw new Error('KINDROID_API_KEY is required');
  const timeoutMs = Number(process.env.KINDROID_REQUEST_TIMEOUT_MS ?? 180000);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 900000
  )
    throw new Error(
      'KINDROID_REQUEST_TIMEOUT_MS must be an integer from 1000 to 900000',
    );
  const path = process.env.BRIDGE_DATABASE_PATH ?? 'data/native.sqlite';
  mkdirSync(dirname(path), { recursive: true });
  const store = new BridgeStore(path);
  try {
    store.register(config);
  } catch (error) {
    store.close();
    throw error;
  }
  const abort = new AbortController();
  const adapter = connectDiscordIngestion(
    store,
    config.id,
    () => loop?.wake(),
    undefined,
    {
      posting: true,
      onFatal: () => {
        process.exitCode = 1;
        void stop();
      },
    },
  );
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    abort.abort();
    // The durable in-flight state remains recoverable if shutdown exceeds the grace period.
    const deadline = setTimeout(() => process.exit(1), 30000);
    deadline.unref();
    stopping = (async () => {
      await Promise.all([adapter.stop(), loop?.stop()]);
      store.close();
      clearTimeout(deadline);
    })();
    return stopping;
  };
  const loop: DeliveryLoop = new DeliveryLoop(
    store,
    config.id,
    new NativeKindroid(store, key, { timeoutMs, signal: abort.signal }),
    new DiscordPosting(store, config.id, adapter.client),
    systemClock,
    (event, detail) => {
      console.log('[delivery]', event, detail);
      if (event === 'fatal') {
        process.exitCode = 1;
        void stop();
      }
    },
  );
  const signal = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  console.log(
    '[native] starting; queued messages will be delivered after Discord catch-up',
  );
  // Ingestion installed the recovery gate; only readiness/catch-up completion wakes delivery.
  try {
    await adapter.client.login(token);
  } catch (error) {
    await stop();
    throw error;
  }
}
