import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store';
import { loadNativeConfig } from './config';
import { DeliveryLoop } from './delivery';
import { FakeClock, FakeDiscord, FakeKin } from './fakes';
import { NativeReply } from './types';

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'kindroid-native-demo-'));
  const path = join(directory, 'bridge.sqlite');
  const config = loadNativeConfig({ DISCORD_BOT_ID: '900', DISCORD_HOME_CHANNEL_ID: '800', KINDROID_AI_ID: 'fake-kin' });
  let store = new BridgeStore(path);
  store.register(config);
  const clock = new FakeClock();
  const kin = new FakeKin();
  const discord = new FakeDiscord(clock);
  let finishGeneration!: (reply: NativeReply) => void;
  const generating = new Promise<NativeReply>(resolve => { finishGeneration = resolve; });
  kin.onSend = async () => kin.calls.length === 1 ? generating : { text: 'I caught up with all five messages.' };
  discord.onPost = async chunk => {
    discord.accept(chunk);
    throw new Error('Simulated lost Discord acknowledgment');
  };
  let loop = new DeliveryLoop(store, config.id, kin, discord, clock);
  try {
    loop.ingest({ id: '1', channelId: '800', authorId: '700', speaker: 'Alice', content: 'Hello', timestamp: 1 });
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let id = 2; id <= 5; id++) loop.ingest({ id: String(id), channelId: '800', authorId: '700', speaker: 'Alice', content: `Follow-up ${id}`, timestamp: id });
    console.log('During generation:', { persisted: store.messages(config.id).length, pending: store.pending(config.id).length, nativeRequests: kin.calls.length });
    finishGeneration({ text: 'more.' });
    await loop.settled();
    console.log('Before restart:', { nativeRequests: kin.calls.length, discordPosts: discord.posts.length, outgoingState: store.nextChunk(config.id)?.state });
    await loop.stop(); store.close();
    store = new BridgeStore(path);
    loop = new DeliveryLoop(store, config.id, kin, discord, clock);
    loop.start(); await loop.settled();
    clock.advance(config.retryBaseMs); await loop.settled();
    console.log('After restart:', { nativeRequests: kin.calls.length, discordPosts: discord.posts.length, reconciliations: discord.checks.length, pending: store.pending(config.id).length, unfinishedReply: !!store.nextChunk(config.id) });
    console.log('Simulation complete: only fake APIs were used; no real messages were sent.');
  } finally {
    await loop.stop(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
