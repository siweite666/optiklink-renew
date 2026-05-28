// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',').map(s => s.trim());
const PROXY_URL = (process.env.PROXY_URL || '').trim();

function nowStr() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/\//g, '-');
}

function sendTG(msg) {
  return new Promise(resolve => {
    if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.setTimeout(15000, () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });
}

test('OptikLink \u81ea\u52a8\u767b\u5f55\u4fdd\u6d3b', async () => {
  if (!DISCORD_TOKEN) throw new Error('\u274c \u7f3a\u5c11 DISCORD_TOKEN');

  const proxyConfig = PROXY_URL ? { server: PROXY_URL } : undefined;
  if (proxyConfig) console.log(`\ud83d\udd17 \u4f7f\u7528\u4ee3\u7406: ${PROXY_URL}`);

  const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    console.log('\ud83d\udd11 [1/5] \u9884\u767b\u5f55 Discord...');
    await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate((token) => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      iframe.contentWindow.localStorage.setItem('token', `\"${token}\"`);
    }, DISCORD_TOKEN);
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    console.log(`\ud83d\udd0d Discord URL: ${page.url()}`);
    await page.screenshot({ path: 'test-results/discord-after-login.png' });

    if (page.url().includes('login')) {
      await page.waitForTimeout(5000);
      if (page.url().includes('login')) {
        throw new Error(`Discord Token \u5931\u6548\uff0cURL: ${page.url()}`);
      }
    }
    console.log('\u2705 Discord Token \u6709\u6548');

    let username = '\u672a\u77e5';
    try {
      username = await page.evaluate(async (tok) => {
        const res = await fetch('https://discord.com/api/v9/users/@me', { headers: { Authorization: tok } });
        if (!res.ok) return '\u672a\u77e5';
        const d = await res.json();
        return d.global_name || d.username || '\u672a\u77e5';
      }, DISCORD_TOKEN);
      console.log(`\ud83d\udc64 \u7528\u6237: ${username}`);
    } catch {}

    console.log('\ud83d\udd17 [2/5] \u8bbf\u95ee OptikLink \u767b\u5f55...');
    await page.goto('https://optiklink.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (page.url().includes('discord.com/oauth2/authorize')) {
      console.log('\ud83d\udd10 [3/5] OAuth \u6388\u6743\u9875\uff0c\u70b9\u51fb Authorize...');
      await page.waitForTimeout(2000);

      for (let i = 0; i < 8; i++) {
        if (!page.url().includes('discord.com')) break;

        const selectors = [
          'button:has-text("Authorize")',
          'button:has-text("\u6388\u6743")',
          'button[type="submit"]',
          'button[class*="primary"]',
        ];

        let clicked = false;
        for (const sel of selectors) {
          try {
            const btn = page.locator(sel).last();
            if (!await btn.isVisible({ timeout: 1000 }).catch(() => false)) continue;
            const text = (await btn.innerText()).trim();
            if (text.includes('\u53d6\u6d88') || text.includes('cancel') || text.includes('deny')) continue;
            if (await btn.isDisabled()) continue;
            console.log(`  \ud83d\udd18 \u70b9\u51fb: \"${text}\"`);
            await Promise.all([
              page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
              btn.click(),
            ]);
            clicked = true;
            await page.waitForTimeout(2000);
            break;
          } catch { continue; }
        }
        if (!clicked) await page.waitForTimeout(2000);
      }
    }

    console.log('\u23f3 [4/5] \u7b49\u5f85\u56de\u8c03...');
    if (page.url().includes('discord.com')) {
      try {
        await page.waitForURL(url => url.toString().includes('optiklink'), { timeout: 15000 });
      } catch {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log(`\ud83d\ucccd \u6700\u7ec8 URL: ${finalUrl}`);
    await page.screenshot({ path: 'test-results/optiklink-result.png', fullPage: true });

    const isError = finalUrl.includes('/error/') || (finalUrl.includes('/login') && finalUrl.includes('optiklink'));
    const time = nowStr();

    if (!isError) {
      const msg = `\u2705 OptikLink \u767b\u5f55\u4fdd\u6d3b\u6210\u529f\n\ud83d\udc64 \u7528\u6237: ${username}\n\ud83d\udd50 \u65f6\u95f4: ${time}\n\ud83d\ucccd URL: ${finalUrl}`;
      console.log(msg);
      await sendTG(msg);
    } else {
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
      const msg = `\u274c OptikLink \u767b\u5f55\u5931\u8d25\n\ud83d\udd50 \u65f6\u95f4: ${time}\n\ud83d\ucccd URL: ${finalUrl}\n\ud83d\udccb ${pageText}`;
      console.error(msg);
      await sendTG(msg);
      throw new Error(`\u767b\u5f55\u5931\u8d25: ${finalUrl}`);
    }

  } catch (err) {
    console.error(`\u274c \u5f02\u5e38: ${err.message}`);
    try { await page.screenshot({ path: 'test-results/optiklink-error.png', fullPage: true }); } catch {}
    await sendTG(`\u274c OptikLink \u767b\u5f55\u5f02\u5e38\n\ud83d\udd50 ${nowStr()}\n\u539f\u56e0: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
});
