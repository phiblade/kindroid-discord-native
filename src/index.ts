import { runNative } from './native/runtime';

void runNative().catch((error) => {
  console.error(
    '[native] startup failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
