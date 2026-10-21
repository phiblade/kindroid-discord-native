import { BridgeConfig } from './types';

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

export function validateConfig(config: BridgeConfig): BridgeConfig {
  for (const name of ['id', 'botId', 'channelId', 'kinId'] as const) {
    if (!config[name]?.trim()) throw new Error(`${name} is required`);
  }
  integer(String(config.maxChars), 4000, 'maxChars', 256, 100000);
  integer(String(config.retryBaseMs), 2000, 'retryBaseMs', 1, 86400000);
  integer(
    String(config.retryMaxMs),
    60000,
    'retryMaxMs',
    config.retryBaseMs,
    86400000,
  );
  integer(String(config.maxReconcileChecks), 5, 'maxReconcileChecks', 1, 100);
  return { ...config };
}

/** Native-only configuration; not used by the inherited live entry point. */
export function loadNativeConfig(
  env: Record<string, string | undefined>,
): BridgeConfig {
  return validateConfig({
    id: env.BRIDGE_ID ?? 'default',
    botId: env.DISCORD_BOT_ID ?? '',
    channelId: env.DISCORD_HOME_CHANNEL_ID ?? '',
    kinId: env.KINDROID_AI_ID ?? '',
    maxChars: integer(
      env.KINDROID_MESSAGE_MAX_CHARS,
      4000,
      'KINDROID_MESSAGE_MAX_CHARS',
      256,
      100000,
    ),
    retryBaseMs: integer(env.RETRY_BASE_MS, 2000, 'RETRY_BASE_MS', 1, 86400000),
    retryMaxMs: integer(env.RETRY_MAX_MS, 60000, 'RETRY_MAX_MS', 1, 86400000),
    maxReconcileChecks: integer(
      env.MAX_RECONCILE_CHECKS,
      5,
      'MAX_RECONCILE_CHECKS',
      1,
      100,
    ),
  });
}
