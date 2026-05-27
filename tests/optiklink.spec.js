// tests/optiklink.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',').map(s => s.trim());
const GOST_PROXY = (process.env.GOST_PROXY || '').trim();

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
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.setTimeout(15000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

test('OptikLink 自动登录保活', async () => {
  if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN');

  // ── 代理配置 ─────────────────────────────────────────
  let proxyConfig = undefined;
  if (GOST_PROXY) {
    try {
      const http = require('http');
      await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, () => resolve());
        r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(); }); r.end();
      });
      proxyConfig = { server: GOST_PROXY };
      console.log('🛡️ 使用代理');
    } catch {
      console.log('⚠️ 代理不可达，直连');
    }
  }

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
    await page.waitForTimeout(4000);

    if (page.url().includes('login')) {
      throw new Error('Discord Token 失效，登录失败');
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

    // ── 3. 打开 OptikLink 登录（触发 OAuth）───────────────
    console.log('🔗 [2/5] 访问 OptikLink 登录...');
    await page.goto('https://optiklink.net/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // ── 4. 处理 Discord OAuth 授权页 ───────────────────────
    if (page.url().includes('discord.com/oauth2/authorize')) {
      console.log('🔐 [3/5] 进入 Discord OAuth 授权页，自动授权...');
      await page.waitForTimeout(2000);

      // 尝试点击 Authorize 按钮（可能需要多次）
      for (let i = 0; i < 8; i++) {
        if (!page.url().includes('discord.com')) break;

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        const selectors = [
          'button:has-text("Authorize")',
          'button:has-text("授权")',
          'button[type="submit"]',
          'div[class*="footer"] button',
          'button[class*="primary"]',
        ];

        for (const sel of selectors) {
          try {
            const btn = page.locator(sel).last();
            if (!await btn.isVisible()) continue;
            const text = (await btn.innerText()).trim();
            if (text.includes('取消') || text.includes('cancel') || text.includes('deny')) continue;
            if (await btn.isDisabled()) continue;
            await btn.click();
            console.log(`  ✅ 点击: "${text}"`);
            await page.waitForTimeout(2000);
            break;
          } catch { continue; }
        }
        await page.waitForTimeout(2000);
      }
    } else if (!page.url().includes('optiklink')) {
      console.log(`⚠️ 未知跳转: ${page.url()}`);
    }

    // ── 5. 等待回到 OptikLink ──────────────────────────────
    console.log('⏳ [4/5] 等待回调...');
    try {
      await page.waitForURL(url => url.toString().includes('optiklink'), { timeout: 15000 });
    } catch {
      // 可能已经在 optiklink 了
    }

    const finalUrl = page.url();
    console.log(`📍 最终 URL: ${finalUrl}`);

    if (!finalUrl.includes('optiklink')) {
      throw new Error(`未回到 OptikLink，当前: ${finalUrl}`);
    }

    // 等页面加载完
    await page.waitForTimeout(5000);

    // 截图留证
    await page.screenshot({ path: 'test-results/optiklink-result.png', fullPage: true });
    console.log('📸 截图已保存');

    // ── 检查页面内容 ───────────────────────────────────────
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    console.log(`📋 页面内容（前200字）: ${pageText.substring(0, 200)}`);

    // ── 通知 ──────────────────────────────────────────────
    const time = nowStr();
    const msg = [
      `✅ OptikLink 登录保活成功`,
      `👤 用户: ${username}`,
      `🕐 时间: ${time}`,
      `📍 URL: ${finalUrl}`,
    ].join('\n');
    console.log(msg);
    await sendTG(msg);

  } catch (err) {
    const time = nowStr();
    const msg = [
      `❌ OptikLink 登录失败`,
      `🕐 时间: ${time}`,
      `原因: ${err.message}`,
    ].join('\n');
    console.error(msg);
    try { await page.screenshot({ path: 'test-results/optiklink-error.png', fullPage: true }); } catch {}
    await sendTG(msg);
    throw err;
  } finally {
    await browser.close();
  }
});
