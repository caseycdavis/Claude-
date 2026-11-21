import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Config = { port: number; host: string; dataDir: string; demo: boolean; webDir: string };

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(env.PARCE_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PARCE_PORT must be a port number, got "${env.PARCE_PORT}"`);
  }
  return {
    port,
    host: env.PARCE_HOST ?? '0.0.0.0',
    dataDir: env.PARCE_DATA_DIR ?? path.join(os.homedir(), '.parce'),
    demo: env.PARCE_DEMO === '1',
    // dist/server/config.js -> dist/web
    webDir: env.PARCE_WEB_DIR ?? path.resolve(here, '..', 'web'),
  };
}
