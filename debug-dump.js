const { chromium } = require('@playwright/test');
const proxyChain = require('proxy-chain');
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const PROXY_URL = process.env.PROXY_URL || '';

(async () => {
  let localProxyUrl, proxyServer;
  if (PROXY_URL) {
    proxyServer = new proxyChain.Server({
      port: 0,
      prepareRequestFunction: () => ({ upstreamProxyUrl: PROXY_URL.startsWith('socks') ? PROXY_URL : 'socks5://' + PROXY_URL }),
    });
    await proxyServer.listen();
    localProxyUrl = `http://127.0.0.1:${proxyServer.port}`;
  }
  const browser = await chromium.launch({ headless: true, proxy: localProxyUrl ? { server: localProxyUrl } : undefined });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000**>;
  await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate((token) => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
  }, TOKEN);
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  console.log('DISCORD URL:', page.url());
  await page.goto('https://optiklink.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('LOGIN URL:', page.url());

  // Handle OAuth authorize clicks
  for (let i = 0; i < 8; i++) {
    if (!page.url().includes('discord.com')) break;
    const btns = ['button:has-text("Authorize")','button:has-text("授权")','button[type="submit"]','button[class*="primary"]'];
    let clicked = false;
    for (const sel of btns) {
      try {
        const btn = page.locator(sel).last();
        if (!await btn.isVisible({ timeout: 800 }).catch(() => false)) continue;
        await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), btn.click()]);
        clicked = true; await page.waitForTimeout(2000); break;
      } catch { continue; }
    }
    if (!clicked) await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000áo);
  console.log('FINAL URL:', page.url());

  // Dump CAPTCHA DOM
  const dump = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action, method: f.method,
      inputs: Array.from(f.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, value: i.value, id: i.id, placeholder: i.placeholder })),
    }));
    const allInputs = Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, value: i.value, id: i.id }));
    return {
      bodyText: document.body.innerText,
      forms,
      allInputs,
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()),
    };
  });
  console.log('===DUMP===');
  console.log(JSON.stringify(dump, null, 2));
  await browser.close();
  if (proxyServer) proxyServer.close();
})();
