// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const proxyChain = require('proxy-chain');
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

test('OptikLink 自动登录保活', async ({}, testInfo) => {
  if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN');

  // Parse proxy: "user:pass@host:port"
  let localProxyUrl, proxyServer;
  if (PROXY_URL) {
    let upstreamUrl = PROXY_URL;
    if (!upstreamUrl.startsWith('socks')) upstreamUrl = 'socks5://' + upstreamUrl;
    console.log(`🔗 启动本地代理转发到: ${upstreamUrl}`);
    proxyServer = new proxyChain.Server({
      port: 0,
      prepareRequestFunction: () => ({ upstreamProxyUrl: upstreamUrl }),
    });
    await proxyServer.listen();
    localProxyUrl = `http://127.0.0.1:${proxyServer.port}`;
    console.log(`🔗 本地代理: ${localProxyUrl}`);
  }

  const proxyConfig = localProxyUrl ? { server: localProxyUrl } : undefined;
  const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    // ── 1. 预登录 Discord ────────────────────────────────
    console.log('🔑 [1/5] 预登录 Discord...');
    await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate((token) => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
    }, DISCORD_TOKEN);
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    console.log(`🔍 Discord URL: ${page.url()}`);
    await page.screenshot({ path: 'test-results/discord-after-login.png' });

    if (page.url().includes('login')) {
      // 可能需要更长时间加载
      await page.waitForTimeout(5000);
      if (page.url().includes('login')) {
        throw new Error(`Discord Token 失效，URL: ${page.url()}`);
      }
    }
    console.log('✅ Discord Token 有效');

    // ── 2. 获取 Discord 用户名 ─────────────────────────────
    let username = '未知';
    try {
      username = await page.evaluate(async (tok) => {
        const res = await fetch('https://discord.com/api/v9/users/@me', { headers: { Authorization: tok } });
        if (!res.ok) return '未知';
        const d = await res.json();
        return d.global_name || d.username || '未知';
      }, DISCORD_TOKEN);
      console.log(`👤 用户: ${username}`);
    } catch {}

    // ── 3. 打开 OptikLink 登录 ─────────────────────────────
    console.log('🔗 [2/5] 访问 OptikLink 登录...');
    await page.goto('https://optiklink.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // ── 4. 处理 OAuth 授权 ─────────────────────────────────
    if (page.url().includes('discord.com/oauth2/authorize')) {
      console.log('🔐 [3/5] OAuth 授权页，点击 Authorize...');
      await page.waitForTimeout(2000);

      for (let i = 0; i < 8; i++) {
        if (!page.url().includes('discord.com')) break;

        const selectors = [
          'button:has-text("Authorize")',
          'button:has-text("授权")',
          'button[type="submit"]',
          'button[class*="primary"]',
        ];

        let clicked = false;
        for (const sel of selectors) {
          try {
            const btn = page.locator(sel).last();
            if (!await btn.isVisible({ timeout: 1000 }).catch(() => false)) continue;
            const text = (await btn.innerText()).trim();
            if (text.includes('取消') || text.includes('cancel') || text.includes('deny')) continue;
            if (await btn.isDisabled()) continue;
            console.log(`  🔘 点击: "${text}"`);
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

    // ── 5. 确认到达 OptikLink ──────────────────────────────
    console.log('⏳ [4/5] 等待回调...');
    if (page.url().includes('discord.com')) {
      try {
        await page.waitForURL(url => url.toString().includes('optiklink'), { timeout: 15000 });
      } catch {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log(`📍 最终 URL: ${finalUrl}`);
    await page.screenshot({ path: 'test-results/optiklink-result.png', fullPage: true });

    // ── 判断结果 ───────────────────────────────────────────
    const isError = finalUrl.includes('/error/') || (finalUrl.includes('/login') && finalUrl.includes('optiklink'));
    const time = nowStr();

    if (!isError) {
      const msg = `✅ OptikLink 登录保活成功\n👤 用户: ${username}\n🕐 时间: ${time}\n📍 URL: ${finalUrl}`;
      console.log(msg);
      await sendTG(msg);
    } else {
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
      const msg = `❌ OptikLink 登录失败\n🕐 时间: ${time}\n📍 URL: ${finalUrl}\n📋 ${pageText}`;
      console.error(msg);
      await sendTG(msg);
      throw new Error(`登录失败: ${finalUrl}`);
    }

  } catch (err) {
    console.error(`❌ 异常: ${err.message}`);
    try { await page.screenshot({ path: 'test-results/optiklink-error.png', fullPage: true }); } catch {}
    // 只在最后一次重试失败时才发通知
    const maxRetries = testInfo.project.retries || 0;
    if (testInfo.retry >= maxRetries) {
      await sendTG(`❌ OptikLink 登录异常\n🕐 ${nowStr()}\n原因: ${err.message}`);
    } else {
      console.log(`⏳ 还有 ${maxRetries - testInfo.retry} 次重试机会，暂不发通知`);
    }
    throw err;
  } finally {
    await browser.close();
    if (proxyServer) {
      proxyServer.close();
      console.log('🔒 本地代理已关闭');
    }
  }
});
