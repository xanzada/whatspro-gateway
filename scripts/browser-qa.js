const path = require('path');
const os = require('os');
const fs = require('fs');
const puppeteer = require('puppeteer');

const outputDir = process.env.QA_OUTPUT || path.join(os.tmpdir(), 'whatspro-browser-qa');
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:3000';
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  let sendRequests = 0;
  const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
  page.on('console', message => {
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
    if (url.includes('/api/chat/media/')) return request.respond({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(wav.length) }, body: wav });
    if (url.includes('/api/chat/send/')) {
      sendRequests += 1;
      return setTimeout(() => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ttl: 60, expiresAt: Date.now() + 60000 }) }), 150);
    }
    if (url.includes('/api/chat/action/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
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
  await page.waitForFunction(() => document.querySelector('.audio-player audio')?.src.includes('/api/chat/media/'));
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

  process.stdout.write(`${JSON.stringify({ contactText, layout, overflow, keyboardLayout, sendRequests, consoleErrors })}\n`);
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
