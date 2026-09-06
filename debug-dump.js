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
  page.setDefaultTimeout(60000);
  await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate((token) => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
  }, TOKEN);
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.goto('https://optiklink.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
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
  await page.waitForTimeout(4000);

  // Fill math answer
  const bodyText = await page.evaluate(() => document.body.innerText);
  const m = bodyText.match(/What is\s+(-?\d+)\s*\+\s*(-?\d+)\s*\?/i);
  let sum = null;
  if (m) {
    sum = parseInt(m[1],10)+parseInt(m[2],10);
    await page.locator('input[name="math_answer"]').fill(String(sum));
    console.log('FILLED math_answer =', sum);
  }
  // Watch turnstile token field
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const ts = await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => '');
    const tsLen = ts ? ts.length : 0;
    const iframes = await page.locator('iframe').count();
    const tsIframes = await page.locator('iframe[src*="turnstile"], iframe[title*="challenge"], iframe[src*="challenges.cloudflare"]').count();
    console.log(`[${(i+1)*2}s] turnstile_len=${tsLen} total_iframes=${iframes} ts_iframes=${tsIframes}`);
    if (tsLen > 20) break
    }
  const dump = await page.evaluate(() => {
    return {
      bodyText: document.body.innerText,
      formHtml: (document.querySelector('form')||{}).outerHTML || 'NO FORM',
    };
  });
  console.log('===FINAL===');
  console.log(dump.bodyText);
  console.log('FORMHTML_START');
  console.log(dump.formHtml.substring(0,2000));
  console.log('FORMHTML_END');
  await browser.close();
  if (proxyServer) proxyServer.close();
})();
