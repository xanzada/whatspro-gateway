const path = require('path');
const os = require('os');
const fs = require('fs');
const puppeteer = require('puppeteer');

const outputDir = process.env.QA_OUTPUT || path.join(os.tmpdir(), 'whatspro-browser-qa');
let baseUrl = process.env.QA_BASE_URL || '';
let qaServer = null;
let browser = null;
fs.mkdirSync(outputDir, { recursive: true });

function playableWav(seconds = 2, sampleRate = 8000) {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index += 1) buffer[44 + index] = 128 + Math.round(24 * Math.sin(2 * Math.PI * 440 * index / sampleRate));
  return buffer;
}

(async () => {
  if (!baseUrl) {
    const { app } = require('../src/server');
    qaServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { qaServer.once('listening', resolve); qaServer.once('error', reject); });
    baseUrl = `http://127.0.0.1:${qaServer.address().port}`;
  }
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('token_key', 'qa-media-token');
    const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      if (String(type).toLowerCase().includes('audio/ogg')) return 'probably';
      return nativeCanPlayType.call(this, type);
    };
  });
  const consoleErrors = [];
  const consoleMessages = [];
  let sendRequests = 0;
  let mediaRequestUrl = '';
  const wav = playableWav();
  page.on('console', message => {
    consoleMessages.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/chat/inbox/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      { phone: '77001234567', displayName: 'Айдана', lastText: 'Сәлеметсіз бе', lastAt: Date.now(), state: 'new' },
      { phone: '77761234956', displayName: 'Телефон іздеу', lastText: 'Ішінара сәйкестік', lastAt: Date.now() - 30000, state: 'new' },
      { phone: '77007654321', displayName: 'Бекзат', lastText: 'Оператор жауап берді', lastAt: Date.now() - 60000, state: 'operator' },
      { phone: '77001112233', lastText: 'Оқылған чат', lastAt: Date.now() - 120000, state: 'all' },
      { phone: '77009998877', displayName: 'Архив', lastText: 'Сақталған', lastAt: Date.now() - 180000, state: 'archive' }
    ] }) });
    if (url.includes('/api/chat/history/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [
      { id: 'c1', role: 'user', direction: 'incoming', text: 'Сәлеметсіз бе', createdAt: Date.now() - 60000 },
      { id: 'o1', role: 'operator', source: 'operator_panel', direction: 'outgoing', text: 'Сәлем! Қалай көмектесемін?', createdAt: Date.now() - 30000, deliveryStatus: 'read' },
      { id: 'd1', role: 'assistant', direction: 'outgoing', text: 'Жеткізілді', createdAt: Date.now() - 20000, deliveryStatus: 'delivered' },
      { id: 'link1', role: 'user', direction: 'incoming', text: 'https://example.com', type: 'ptt', hasMedia: true, mediaType: 'text/html', createdAt: Date.now() - 15000 },
      { id: 'a1', role: 'user', direction: 'incoming', type: 'ptt', hasMedia: true, mediaType: 'audio/wav', createdAt: Date.now() - 10000 }
    ] }) });
    if (url.includes('/api/chat/operator-lock/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ttl: 42, expiresAt: Date.now() + 42000 }) });
    if (url.includes('/api/chat/events/')) return request.respond({ status: 200, contentType: 'text/event-stream', body: 'retry: 3000\n\n' });
    if (url.includes('/api/chat/media/')) {
      mediaRequestUrl = url;
      return request.respond({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(wav.length) }, body: wav });
    }
    if (url.includes('/api/chat/send/')) {
      sendRequests += 1;
      return setTimeout(() => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ttl: 60, expiresAt: Date.now() + 60000 }) }), 150);
    }
    if (url.includes('/api/chat/action/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    if (request.resourceType() === 'document' && url.startsWith(baseUrl) && process.env.QA_EMBED_TOKEN) {
      return request.continue({ headers: { ...request.headers(), 'x-whatspro-embed-token': process.env.QA_EMBED_TOKEN } });
    }
    return request.continue();
  });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/chat.html?instance=prestige`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.contact-item');
  const contactText = await page.$eval('.contact-item', element => element.innerText);
  if (!contactText.includes('Айдана') || !contactText.includes('+77001234567') || !contactText.includes('Сәлеметсіз бе')) throw new Error('CONTACT_HIERARCHY');
  for (const query of ['776', '8776', '4956']) {
    await page.$eval('#search-input', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, query);
    const matchedPhone = await page.$eval('.contact-item', element => element.dataset.phone);
    if (matchedPhone !== '77761234956') throw new Error(`PHONE_SEARCH_${query}`);
  }
  await page.$eval('#search-input', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.screenshot({ path: path.join(outputDir, 'chat-desktop-list.png'), fullPage: true });
  await page.click('.contact-item');
  await page.waitForSelector('.message-row.operator');
  await page.waitForFunction(() => {
    const src = document.querySelector('.audio-player audio')?.src || '';
    const token = src ? new URL(src).searchParams.get('token') : '';
    return src.includes('/api/chat/media/') && token === window.__CHAT_CONFIG__.chatToken && src.includes('fmt=mp4');
  });
  const configuredChatToken = await page.evaluate(() => window.__CHAT_CONFIG__.chatToken);
  await page.evaluate(() => { window.__qaOriginalPlayButton = document.querySelector('.audio-play'); });
  await page.click('#lang-btn');
  await page.waitForFunction(() => {
    const button = document.querySelector('.audio-play');
    const src = button?.closest('.audio-player')?.querySelector('audio')?.src || '';
    return button && button !== window.__qaOriginalPlayButton && src.includes('/api/chat/media/');
  });
  const audioClick = await page.evaluate(async () => {
    const button = document.querySelector('.audio-play');
    const audio = button.closest('.audio-player').querySelector('audio');
    const cursor = getComputedStyle(button).cursor;
    const rerendered = button !== window.__qaOriginalPlayButton && !window.__qaOriginalPlayButton.isConnected;
    const waitForProgress = () => new Promise(resolve => {
      const deadline = Date.now() + 1500;
      const check = () => audio.currentTime > 0 ? resolve(true) : Date.now() >= deadline ? resolve(false) : setTimeout(check, 25);
      check();
    });

    button.click();
    const directPlayed = await waitForProgress();
    button.click();

    audio.currentTime = 0;
    button.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1 L9 5 L1 9 Z"></path></svg>';
    button.querySelector('path').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const nestedPlayed = await waitForProgress();
    audio.pause();
    return {
      disabled: button.disabled,
      cursor,
      rerendered,
      directPlayed,
      nestedPlayed,
      duration: audio.duration
    };
  });
  if (audioClick.disabled || audioClick.cursor === 'not-allowed' || !audioClick.rerendered || !audioClick.directPlayed || !audioClick.nestedPlayed || !(audioClick.duration > 0)) throw new Error(`AUDIO_CLICK_${JSON.stringify(audioClick)}`);
  if (!consoleMessages.some(message => message.includes('PLAY BUTTON CLICKED')) || !consoleMessages.some(message => message.includes('CALLING AUDIO PLAY'))) throw new Error('AUDIO_CLICK_LOGS');
  const mediaRequest = new URL(mediaRequestUrl);
  if (mediaRequest.searchParams.get('token') !== configuredChatToken || mediaRequest.searchParams.get('phone') !== '77001234567' || !mediaRequestUrl.includes('fmt=mp4')) throw new Error(`AUDIO_MEDIA_URL_${mediaRequestUrl}`);
  const layout = await page.evaluate(() => {
    const client = document.querySelector('.message-row.client .bubble').getBoundingClientRect();
    const operator = document.querySelector('.message-row.operator .bubble').getBoundingClientRect();
    return {
      clientLeft: client.left,
      operatorLeft: operator.left,
      ticks: document.querySelector('.message-row.operator .ticks')?.textContent,
      deliveredTicks: document.querySelector('.ticks.delivered')?.textContent,
      audioPlayers: document.querySelectorAll('.audio-player').length,
      audioHttpSource: document.querySelector('.audio-player audio')?.src.includes('/api/chat/media/'),
      lock: document.querySelector('#lock-seconds').textContent
    };
  });
  if (!(layout.clientLeft < layout.operatorLeft) || layout.ticks !== '✓✓' || layout.deliveredTicks !== '✓✓' || layout.audioPlayers !== 1 || !layout.audioHttpSource || !layout.lock) throw new Error('MESSAGE_LAYOUT');
  await page.screenshot({ path: path.join(outputDir, 'chat-desktop-active.png'), fullPage: true });

  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.focus('#message-input');
  await page.type('#message-input', 'бір рет');
  await page.evaluate(() => {
    document.querySelector('#send-btn').click();
    document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  if (sendRequests !== 1) throw new Error(`SEND_DEBOUNCE_${sendRequests}`);
  await page.setViewport({ width: 375, height: 480, deviceScaleFactor: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  const keyboardLayout = await page.evaluate(() => {
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const viewport = window.visualViewport;
    return { composerBottom: composer.bottom, viewportBottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) };
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow || keyboardLayout.composerBottom > keyboardLayout.viewportBottom + 1) throw new Error('MOBILE_LAYOUT');
  await page.screenshot({ path: path.join(outputDir, 'chat-mobile-active.png'), fullPage: true });

  process.stdout.write(`${JSON.stringify({ contactText, layout, audioClick, overflow, keyboardLayout, sendRequests, consoleErrors })}\n`);
  await browser.close();
  browser = null;
  if (qaServer) await new Promise(resolve => qaServer.close(resolve));
  qaServer = null;
})().catch(async error => {
  if (browser) await browser.close().catch(() => {});
  if (qaServer) await new Promise(resolve => qaServer.close(resolve));
  console.error(error);
  process.exitCode = 1;
});
