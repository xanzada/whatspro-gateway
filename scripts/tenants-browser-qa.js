const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '..', 'public');
const outputDir = path.join(os.tmpdir(), 'whatspro-tenants-qa');
fs.mkdirSync(outputDir, { recursive: true });

const qr = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="white"/><path d="M20 20h65v65H20zm115 0h65v65h-65zM20 135h65v65H20zm92-20h28v28h-28zm43 0h45v20h-45zm-43 47h20v38h-20zm42-15h46v53h-22v-25h-24z" fill="black"/></svg>'
)}`;

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  const file = pathname === '/tenants.html' ? 'tenants.html' : pathname === '/tenants.css' ? 'tenants.css' : pathname === '/tenants.js' ? 'tenants.js' : '';
  if (!file) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html';
  response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
  response.end(fs.readFileSync(path.join(publicDir, file)));
});

(async () => {
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    let prestigeStatus = 'disconnected';
    let startCalls = 0;
    let tenantCreateCalls = 0;
    let instanceCreateCalls = 0;
    let lastStartInstance = '';
    const extraInstances = [];

    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const json = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/wa/tenants' && request.method() === 'POST') {
        tenantCreateCalls += 1;
        return request.respond({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, instanceId: 'qa-cafe' }) });
      }
      if (url.pathname === '/api/wa/tenants') return json({
        success: true,
        total: 2,
        tenants: [
          { instanceId: 'prestige', brand: 'Crazy суши', active: true, summary: { ready: true }, createdAt: '2026-07-20T12:00:00Z' },
          { instanceId: 'maki', brand: 'Маки', active: true, summary: { ready: false }, createdAt: '2026-07-21T12:00:00Z' }
        ]
      });
      if (url.pathname === '/api/wa/instances' && request.method() === 'POST') {
        instanceCreateCalls += 1;
        const body = JSON.parse(request.postData() || '{}');
        extraInstances.push({ instanceId: body.instanceId, label: body.label });
        return json({ success: true, instanceId: body.instanceId });
      }
      if (url.pathname === '/api/wa/instances') return json({
        success: true,
        instances: [{ instanceId: 'prestige', label: 'Crazy суши' }, { instanceId: 'maki', label: 'Маки' }].concat(extraInstances)
      });
      if (url.pathname === '/api/wa/tenant-defaults') return json({ domainSuffix: 'bekaba.com', workHours: '09:00 - 23:00' });
      if (url.pathname.endsWith('/settings')) {
        const isPrestige = url.pathname.includes('prestige');
        return json({ tenant: {
          domain: isPrestige ? 'prestige.bekaba.com' : 'maki.alemi.kz',
          whatsappPhone: isPrestige ? '+77769156184' : '+77067150899',
          systemPrompt: isPrestige ? '# PRESTIGE — BRAND VOICE' : 'Сәлем'
        } });
      }
      if (url.pathname.includes('/api/wa/status/prestige')) return json({
        status: prestigeStatus,
        qr: prestigeStatus === 'qr_ready' ? qr : undefined,
        hasStoredSession: false
      });
      if (url.pathname.includes('/api/wa/status/maki')) return json({ status: 'connected', hasStoredSession: true });
      if (url.pathname.includes('/api/wa/status/qa-cafe')) return json({ status: 'qr_ready', qr, hasStoredSession: false });
      if (url.pathname === '/api/wa/start') {
        startCalls += 1;
        const body = JSON.parse(request.postData() || '{}');
        lastStartInstance = body.instanceId;
        if (body.instanceId === 'prestige') prestigeStatus = 'qr_ready';
        return json({ status: 'qr_ready', qr });
      }
      return json({ success: true });
    });

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${baseUrl}/tenants.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('tbody tr');

    const initial = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.querySelector('h1')?.textContent,
      connected: document.querySelector('#stat-connected')?.textContent,
      nav: Array.from(document.querySelectorAll('.main-nav button')).map(node => node.textContent.trim()),
      statuses: Array.from(document.querySelectorAll('[data-live-status]')).map(node => node.textContent.trim())
    }));
    if (initial.lang !== 'kk' || initial.title !== 'Басқару панелі') throw new Error(`KAZAKH_DEFAULT:${JSON.stringify(initial)}`);
    if (initial.connected !== '1') throw new Error(`FALSE_CONNECTED_COUNT:${JSON.stringify(initial)}`);
    if (initial.nav.some(text => /Provisioning|Activity/i.test(text))) throw new Error('UNNEEDED_NAV_VISIBLE');
    if (!initial.statuses.includes('Қосылмаған') || !initial.statuses.includes('Қосылған')) throw new Error(`LIVE_STATUS_MAPPING:${initial.statuses.join(',')}`);

    await page.screenshot({ path: path.join(outputDir, 'tenants-desktop-kk.png'), fullPage: true });
    await page.click('[data-action="new"]');
    await page.type('[name="brand"]', 'QA Cafe');
    await page.click('[data-wizard-next]');
    await page.click('[data-wizard-next]');
    await page.click('[data-wizard-next]');
    await page.click('[data-wizard-next]');
    await page.waitForFunction(() => document.querySelector('.success-panel'));
    if (tenantCreateCalls !== 1 || instanceCreateCalls !== 1 || lastStartInstance !== 'qa-cafe') {
      throw new Error(`CREATE_SYNC:${JSON.stringify({ tenantCreateCalls, instanceCreateCalls, lastStartInstance })}`);
    }
    await page.click('[data-modal-close]');

    await page.click('#locale-button');
    await page.click('[data-locale="ru"]');
    const russianTitle = await page.$eval('h1', node => node.textContent);
    if (russianTitle !== 'Панель управления') throw new Error(`RUSSIAN_SWITCH:${russianTitle}`);

    await page.click('#focus-mode');
    const lightTheme = await page.$eval('html', node => node.dataset.theme);
    if (lightTheme !== 'light') throw new Error(`THEME_SWITCH:${lightTheme}`);
    await page.screenshot({ path: path.join(outputDir, 'tenants-desktop-ru-light.png'), fullPage: true });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('tbody tr');
    await page.click('tbody tr:first-child [data-action="menu"]');
    await page.waitForSelector('.action-sheet');
    const mobile = await page.evaluate(() => {
      const sheet = document.querySelector('.action-sheet');
      const modal = document.querySelector('.modal');
      const rect = modal.getBoundingClientRect();
      return {
        sheetVisible: Boolean(sheet),
        modalBottom: Math.round(rect.bottom),
        viewport: window.innerHeight,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });
    if (!mobile.sheetVisible || mobile.modalBottom > mobile.viewport + 1 || mobile.overflow > 1) throw new Error(`MOBILE_ACTION_SHEET:${JSON.stringify(mobile)}`);
    await page.screenshot({ path: path.join(outputDir, 'tenants-mobile-actions.png'), fullPage: true });

    await page.click('.action-sheet [data-action="qr"]');
    await page.waitForSelector('#qr-frame img', { timeout: 8000 });
    if (!startCalls) throw new Error('QR_DID_NOT_START_SHARED_INSTANCE');
    await page.screenshot({ path: path.join(outputDir, 'tenants-mobile-qr.png'), fullPage: true });

    if (consoleErrors.length || pageErrors.length) throw new Error(`BROWSER_ERRORS:${JSON.stringify({ consoleErrors, pageErrors })}`);
    console.log(JSON.stringify({ ok: true, outputDir, initial, mobile, startCalls, tenantCreateCalls, instanceCreateCalls }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
