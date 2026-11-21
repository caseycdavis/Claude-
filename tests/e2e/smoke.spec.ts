import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

// Playwright is installed outside the project on the build machine.
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'correct horse battery';

let server: ChildProcess;
let dataDir: string;
let browser: import('playwright').Browser;
let page: import('playwright').Page;

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The server did not start.');
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parce-e2e-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/index.js'], {
    env: { ...process.env, PARCE_DEMO: '1', PARCE_PORT: String(PORT), PARCE_HOST: '127.0.0.1', PARCE_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
});

afterAll(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('first run, a message from Juan, a previewed reply, and a send that fails while the link is down', async () => {
  // First run: choose a passphrase.
  await page.goto(BASE);
  await page.getByLabel('Choose a passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Continue' }).click();

  // The chat opens. A message from the stand-in Juan shows its original and its translation.
  await expect.poll(() => page.getByRole('heading', { name: 'Juan' }).isVisible()).toBe(true);
  await page.getByLabel('Play Juan').fill('hola parce');
  await page.getByRole('button', { name: 'Send as Juan' }).click();
  await expect.poll(() => page.getByText('[EN] hola parce').isVisible()).toBe(true);
  expect(await page.getByText('hola parce', { exact: true }).isVisible()).toBe(true);

  // Draft, preview, tone.
  await page.getByLabel('Message in English').fill('wait for me');
  await page.getByRole('button', { name: 'Translate' }).click();
  await expect.poll(() => page.getByText('[ES:base] wait for me', { exact: true }).isVisible()).toBe(true);
  expect(await page.getByText('[BACK] [ES:base] wait for me', { exact: true }).isVisible()).toBe(true);
  await page.getByRole('button', { name: 'Warmer' }).click();
  await expect.poll(() => page.getByText('[ES:warmer] wait for me', { exact: true }).isVisible()).toBe(true);

  // Send: one outgoing bubble with both lines, and an empty composer.
  await page.getByRole('button', { name: 'Send to Juan' }).click();
  await expect.poll(() => page.getByLabel('Message in English').inputValue()).toBe('');
  const sent = page.getByRole('listitem').filter({ hasText: '[ES:warmer] wait for me' });
  expect(await sent.count()).toBe(1);
  expect(await sent.getByText('wait for me', { exact: true }).isVisible()).toBe(true);

  // With the link down, a send is refused and the draft stays put.
  await page.getByRole('button', { name: 'Break the link' }).click();
  await expect.poll(() => page.getByText('WhatsApp link down').first().isVisible()).toBe(true);
  await page.getByLabel('Message in English').fill('are you there');
  await page.getByRole('button', { name: 'Translate' }).click();
  await expect.poll(() => page.getByText('[ES:base] are you there', { exact: true }).isVisible()).toBe(true);
  await page.getByRole('button', { name: 'Send to Juan' }).click();
  await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true);
  expect(await page.getByText('[ES:base] are you there', { exact: true }).isVisible()).toBe(true);
  expect(await page.getByRole('listitem').filter({ hasText: 'are you there' }).count()).toBe(0);

  // Reloading keeps the session and the history.
  await page.reload();
  await expect.poll(() => page.getByText('[EN] hola parce').isVisible()).toBe(true);
});
