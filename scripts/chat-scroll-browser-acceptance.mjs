// GH-32: real compiled chat scrolling, synthetic backend only; no voice/model access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { chromium } = await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const port = Number(process.env.CREW_ACCEPTANCE_PORT || 4348), origin = `http://127.0.0.1:${port}`;
const output = await mkdtemp(path.join(tmpdir(), 'crew-chat-scroll-'));
const fixture = spawn(process.execPath, ['tests/browser-fixture.mjs', String(port), process.env.CREW_RENDERER_ASSETS || path.resolve('runtime/renderer-dist')], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
// Register disposal before observing the fixture; only this test's processes are owned.
const cleanup = async () => { await browser?.close(); if (fixture.exitCode === null) { fixture.kill('SIGTERM'); await once(fixture, 'exit'); } };
try {
  await new Promise((resolve, reject) => { fixture.stdout.once('data', resolve); fixture.once('error', reject); fixture.once('exit', code => reject(Error(`Fixture exited ${code}`))); });
  browser = await chromium.launch({ headless: true, ...(process.env.CREW_BROWSER_EXECUTABLE ? { executablePath: process.env.CREW_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const post = body => context.request.post(`${origin}/__control`, { data: body });
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `scroll-${i}`, position: i, role: i % 2 ? 'assistant' : 'user', status: 'complete', source: 'text', text: `Message ${i}\n\n${'A retained paragraph for scroll acceptance. '.repeat(i === 29 ? 100 : 12)}` }));
  await post({ work: { messages } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const viewport = page.getByRole('region', { name: 'Manager conversation', exact: true });
  await page.locator('[data-slot="message-scroller-item"][data-message-id="scroll-29"]').waitFor();
  const metrics = () => viewport.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, bottom: el.scrollHeight - el.clientHeight - el.scrollTop }));
  // Let content-visibility settle so assertions cover actual rendered row geometry.
  const settle = () => page.waitForTimeout(400);
  await settle();
  assert.ok((await metrics()).bottom < 3, 'Loaded history opens at the bottom');
  const bottom = () => viewport.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await bottom(); await settle();
  const beforeRefresh = await metrics();
  assert.ok(beforeRefresh.bottom < 3);
  await post({ work: { activeTurnId: 'scroll-turn', status: 'working' } });
  await settle();
  assert.ok((await metrics()).bottom < 3, 'A state/typing update keeps a reader at the bottom');
  await viewport.evaluate(el => { el.scrollTop = Math.round(el.scrollHeight * 0.35); el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await viewport.hover(); await page.mouse.wheel(0, -50); await settle();
  const reading = await metrics();
  assert.ok(reading.bottom > 1000);
  for (let i = 0; i < 4; i++) {
    await post({ work: { messages: structuredClone(messages), status: 'working' } }); await settle();
    assert.ok(Math.abs((await metrics()).top - reading.top) < 3, 'Repeated equivalent state refresh preserves scroll position');
  }
  const nextUser = { id: 'scroll-new-user', position: 30, role: 'user', status: 'complete', source: 'voice', text: 'A new observed user message arrives while reading history.' };
  messages.push(nextUser);
  await post({ work: { messages } }); await settle();
  assert.ok(Math.abs((await metrics()).top - reading.top) < 3, 'A new user message never anchors over a reader in history');
  const response = { id: 'scroll-response', position: 31, role: 'assistant', status: 'streaming', source: 'text', text: 'Streaming response begins.' };
  messages.push(response);
  await post({ work: { messages } }); await settle();
  response.text += '\n\n' + 'Streaming text grows. '.repeat(150);
  await post({ work: { messages } }); await settle();
  assert.ok(Math.abs((await metrics()).top - reading.top) < 3, 'Growing response preserves history position');
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await page.waitForFunction(() => { const el = document.querySelector('[data-slot="message-scroller-viewport"]'); return el.scrollHeight - el.clientHeight - el.scrollTop < 3; });
  response.text += '\n\n' + 'More streamed text. '.repeat(100);
  await post({ work: { messages } }); await settle();
  assert.ok((await metrics()).bottom < 3, 'Jump to latest resumes following streaming text');
  messages.push({ ...nextUser, id: 'scroll-next-user', position: 32 });
  await post({ work: { messages, activeTurnId: null, status: 'idle' } }); await settle();
  assert.ok((await metrics()).bottom < 3, 'New messages and completion keep following the bottom');
  await viewport.hover(); await page.mouse.wheel(0, -40); await settle();
  const nearBottom = await metrics();
  assert.ok(nearBottom.bottom > 8 && nearBottom.bottom < 100, 'Small deliberate scroll leaves following mode');
  messages.push({ ...response, id: 'scroll-near-bottom', position: 33, status: 'complete', text: 'New output while reading just above the bottom.' });
  await post({ work: { messages } }); await settle();
  assert.ok(Math.abs((await metrics()).top - nearBottom.top) < 3, 'A reader just above the bottom stays put');
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click(); await settle();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your manager', exact: true }).fill('Composer changes keep the bottom in view'); await settle();
  assert.ok((await metrics()).bottom < 3, 'Composer layout changes preserve bottom following');
  await page.screenshot({ path: path.join(output, 'chat-following.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, output, stateRefresh: true, readerPosition: true, userAppend: true, streaming: true, jumpToLatest: true, completion: true, composerResize: true, syntheticOnly: true }));
} finally { await cleanup(); }
