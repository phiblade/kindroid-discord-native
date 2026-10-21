import { loadPresentation } from './presentation';
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadNativeConfig } from './config';
import { BridgeStore } from './store';
import { connectDiscordIngestion } from './discord-ingestion';

async function main(): Promise<void> {
  const config = loadNativeConfig(process.env);
  const presentation = loadPresentation(process.env);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is required');
  const path = process.env.BRIDGE_DATABASE_PATH ?? 'data/native.sqlite';
  mkdirSync(dirname(path), { recursive: true });
  const store = new BridgeStore(path);
  store.configurePresentation(config.id, presentation);
  store.register(config);
  const adapter = connectDiscordIngestion(store, config.id);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await adapter.stop();
    store.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  try {
    await adapter.client.login(token);
  } catch (error) {
    await stop();
    throw error;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
