import dotenv from 'dotenv';
import { initializeAllBots, shutdownAllBots } from './discordManager';
import { BotConfig } from './types';

dotenv.config();

/**
 * Load bot configurations from environment variables
 * Looks for pairs of SHARED_AI_CODE_N and BOT_TOKEN_N where N starts from 1
 * @returns Array of bot configurations
 */
function loadBotConfigs(): BotConfig[] {
  const configs: BotConfig[] = [];
  let currentIndex = 1;

  let hasMoreConfigs = true;
  while (hasMoreConfigs) {
    const sharedAiCode = process.env[`SHARED_AI_CODE_${currentIndex}`];
    const botToken = process.env[`BOT_TOKEN_${currentIndex}`];

    // If either required value is missing, we've reached the end of our configs
    if (!sharedAiCode || !botToken) {
      hasMoreConfigs = false;
      break;
    }

    // Get optional settings
    const enableFilter =
      process.env[`ENABLE_FILTER_${currentIndex}`]?.toLowerCase() === 'true';

    configs.push({
      id: `bot${currentIndex}`,
      discordBotToken: botToken,
      sharedAiCode,
      enableFilter,
    });

    currentIndex++;
  }

  return configs;
}

/**
 * Validate environment variables
 * @throws Error if required variables are missing
 */
function validateEnv(): void {
  const requiredVars = [
    'KINDROID_INFER_URL',
    'KINDROID_API_KEY',
    'SHARED_AI_CODE_1', // At least one bot is required
    'BOT_TOKEN_1',
  ] as const;

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    console.error(
      'Missing required environment variables:',
      missing.join(', '),
    );
    process.exit(1);
  }

  // Validate bot config pairs
  let currentIndex = 1;
  let hasMoreConfigs = true;
  while (hasMoreConfigs) {
    const hasSharedAiCode = !!process.env[`SHARED_AI_CODE_${currentIndex}`];
    const hasBotToken = !!process.env[`BOT_TOKEN_${currentIndex}`];

    // If neither exists, we're done checking
    if (!hasSharedAiCode && !hasBotToken) {
      hasMoreConfigs = false;
      break;
    }

    // If one exists without the other, that's an error
    if (hasSharedAiCode !== hasBotToken) {
      console.error(
        `Error: Bot ${currentIndex} must have both SHARED_AI_CODE_${currentIndex} and BOT_TOKEN_${currentIndex} defined`,
      );
      process.exit(1);
    }

    currentIndex++;
  }
}

async function main(): Promise<void> {
  try {
    // Validate environment
    validateEnv();

    // Load bot configurations
    const botConfigs = loadBotConfigs();

    if (botConfigs.length === 0) {
      console.error(
        'No valid bot configurations found in environment variables',
      );
      process.exit(1);
    }

    console.log(`Found ${botConfigs.length} bot configurations`);

    // Initialize all bots
    await initializeAllBots(botConfigs);
    console.log('All bots initialized successfully!');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT. Shutting down...');
      await shutdownAllBots();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM. Shutting down...');
      await shutdownAllBots();
      process.exit(0);
    });
  } catch (error) {
    console.error('Fatal error during initialization:', error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
