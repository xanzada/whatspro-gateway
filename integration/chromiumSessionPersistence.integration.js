const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

test('a real Chromium profile preserves session data across a restart', { timeout: 120_000 }, async t => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatspro-chromium-session-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>WhatsPro session probe</title>');
  });
  const address = await listen(server);
  const url = `http://127.0.0.1:${address.port}/`;
  let firstBrowser = null;
  let restoredBrowser = null;

  t.after(async () => {
    await firstBrowser?.close().catch(() => {});
    await restoredBrowser?.close().catch(() => {});
    await closeServer(server);
    await fs.rm(profileDir, { recursive: true, force: true });
  });

  const launch = () => puppeteer.launch({
    headless: true,
    userDataDir: profileDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  firstBrowser = await launch();
  const firstPage = await firstBrowser.newPage();
  await firstPage.goto(url);
  await firstPage.evaluate(() => localStorage.setItem('whatspro-session-probe', 'restored'));
  await firstBrowser.close();
  firstBrowser = null;

  restoredBrowser = await launch();
  const restoredPage = await restoredBrowser.newPage();
  await restoredPage.goto(url);
  const restored = await restoredPage.evaluate(() => localStorage.getItem('whatspro-session-probe'));
  await restoredBrowser.close();
  restoredBrowser = null;

  assert.equal(restored, 'restored');
});
