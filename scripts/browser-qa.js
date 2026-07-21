const path = require('path');
const puppeteer = require('puppeteer');

const outputDir = process.env.QA_OUTPUT || process.cwd();
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:3127';

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/chat/inbox/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      { phone: '77001234567', displayName: 'Айдана', lastText: 'Сәлеметсіз бе', lastAt: Date.now(), state: 'new' },
      { phone: '77007654321', displayName: 'Бекзат', lastText: 'Оператор жауап берді', lastAt: Date.now() - 60000, state: 'operator' },
      { phone: '77001112233', lastText: 'Оқылған чат', lastAt: Date.now() - 120000, state: 'all' },
      { phone: '77009998877', displayName: 'Архив', lastText: 'Сақталған', lastAt: Date.now() - 180000, state: 'archive' }
    ] }) });
    if (url.includes('/api/chat/history/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [
      { id: 'c1', role: 'user', direction: 'incoming', text: 'Сәлеметсіз бе', createdAt: Date.now() - 60000 },
      { id: 'o1', role: 'operator', source: 'operator_panel', direction: 'outgoing', text: 'Сәлем! Қалай көмектесемін?', createdAt: Date.now() - 30000, deliveryStatus: 'read' },
      { id: 'a1', role: 'assistant', direction: 'outgoing', type: 'ptt', hasMedia: true, mediaType: 'audio/ogg', createdAt: Date.now() - 10000, deliveryStatus: 'sent' }
    ] }) });
    if (url.includes('/api/chat/operator-lock/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ttl: 42, expiresAt: Date.now() + 42000 }) });
    if (url.includes('/api/chat/events/')) return request.respond({ status: 200, contentType: 'text/event-stream', body: 'retry: 3000\n\n' });
    if (url.includes('/api/chat/media/')) return request.respond({ status: 404, contentType: 'application/json', body: '{}' });
    if (url.includes('/api/chat/action/') || url.includes('/api/chat/send/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ttl: 60, expiresAt: Date.now() + 60000 }) });
    return request.continue();
  });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/chat.html?instance=prestige`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.contact-item');
  const contactText = await page.$eval('.contact-item', element => element.innerText);
  if (!contactText.includes('Айдана') || !contactText.includes('+77001234567') || !contactText.includes('Сәлеметсіз бе')) throw new Error('CONTACT_HIERARCHY');
  await page.screenshot({ path: path.join(outputDir, 'chat-desktop-list.png'), fullPage: true });
  await page.click('.contact-item');
  await page.waitForSelector('.message-row.operator');
  const layout = await page.evaluate(() => {
    const client = document.querySelector('.message-row.client .bubble').getBoundingClientRect();
    const operator = document.querySelector('.message-row.operator .bubble').getBoundingClientRect();
    return {
      clientLeft: client.left,
      operatorLeft: operator.left,
      ticks: document.querySelector('.message-row.operator .ticks')?.textContent,
      lock: document.querySelector('#lock-seconds').textContent
    };
  });
  if (!(layout.clientLeft < layout.operatorLeft) || layout.ticks !== '✓✓' || !layout.lock) throw new Error('MESSAGE_LAYOUT');
  await page.screenshot({ path: path.join(outputDir, 'chat-desktop-active.png'), fullPage: true });

  await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
  await new Promise(resolve => setTimeout(resolve, 200));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('MOBILE_OVERFLOW');
  await page.screenshot({ path: path.join(outputDir, 'chat-mobile-active.png'), fullPage: true });

  process.stdout.write(`${JSON.stringify({ contactText, layout, overflow, consoleErrors })}\n`);
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
