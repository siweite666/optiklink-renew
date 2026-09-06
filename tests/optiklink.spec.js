// tests/optiklink.spec.js
const { test, chromium } = require('@playwright/test');
const proxyChain = require('proxy-chain');
const https = require('https');
const http = require('http');

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',').map(s => s.trim());
const PROXY_URL = (process.env.PROXY_URL || '').trim();

// Pterodactyl 开机检测（可选）
const PTERODACTYL_API_KEY = (process.env.PTERODACTYL_API_KEY || '').trim();
const PTERODACTYL_PANEL_URL = (process.env.PTERODACTYL_PANEL_URL || '').trim();
const PTERODACTYL_SERVER_ID = (process.env.PTERODACTYL_SERVER_ID || '').trim();

function nowStr() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/\//g, '-');
}

// === OptikLink 数学验证码处理 ===
// OptikLink 在 Discord OAuth 回跳后会在 /login 显示一个"Quick Verification"页：
//   "Please solve the simple math question below before continuing with Discord login.
//    What is 4 + 9 ?   [answer input]   CONTINUE WITH LOGIN"
// 解析算式、填入结果、点击按钮。
async function solveMathCaptcha(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // 页面可能还在渲染，先等元素出现
    try {
      await page.waitForSelector('input', { timeout: 3000 });
    } catch { return false; }

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!bodyText.includes('Quick Verification') && !bodyText.includes('CONTINUE WITH LOGIN')) {
      return false;
    }

    // 提取算式: "What is 4 + 9 ?"
    const m = bodyText.match(/What is\s+(-?\d+)\s*\+\s*(-?\d+)\s*\?/i);
    if (!m) {
      console.log('  🧮 检测到验证页但无法解析算式');
      await page.waitForTimeout(1500);
      continue;
    }
    const sum = parseInt(m[1], 10) + parseInt(m[2], 10);
    console.log(`  🧮 数学验证: ${m[1]} + ${m[2]} = ${sum}`);

    // 填入答案 —— 用最可能的 input（验证页上通常只有一个可输入的 input）
    const inputs = page.locator('input');
    const cnt = await inputs.count();
    let filled = false;
    for (let i = 0; i < cnt; i++) {
      const el = inputs.nth(i);
      const vis = await el.isVisible().catch(() => false);
      if (!vis) continue;
      const t = (await el.inputValue().catch(() => '')).trim();
      const type = await el.getAttribute('type').catch(() => '');
      // 跳过明显非答案输入（隐藏/只读/已有内容/非文本类型）
      if (t || ['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(type)) continue;
      await el.fill(String(sum)).catch(() => {});
      filled = true;
      console.log(`  ⌨️  已填入答案到 input[${i}]`);
      break;
    }
    if (!filled) {
      console.log('  ⚠️  未找到可填的答案输入框');
      await page.waitForTimeout(1500);
      continue;
    }

    // 点击 CONTINUE WITH LOGIN
    const contBtn = page.locator('button:has-text("CONTINUE WITH LOGIN"), button:has-text("Continue with Login")').first();
    if (await contBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await Promise.all([
        page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
        contBtn.click(),
      ]);
    } else {
      // 备用：点击页面主按钮
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(3000);

    // 校验是否通过
    const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!afterText.includes('CONTINUE WITH LOGIN')) {
      console.log('  ✅ 数学验证通过');
      return true;
    }
    console.log('  🔄 验证未通过，重试...');
    await page.waitForTimeout(1500);
  }
  return false;
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

// === Pterodactyl 开机检测 ===
// 在跑 Discord 登录前，先用 Pterodactyl Client API 看服务器状态。
// offline -> 发 start 信号；suspended 跳过；其他状态跳过。
// 失败不阻塞登录（因为 Pterodactyl 是可选的）。
async function checkAndPowerOnServer() {
  if (!PTERODACTYL_API_KEY || !PTERODACTYL_PANEL_URL || !PTERODACTYL_SERVER_ID) {
    console.log('⏭️  未配置 Pterodactyl，跳过开机检测（需要 PTERODACTYL_API_KEY/PANEL_URL/SERVER_ID）');
    return { skipped: true };
  }

  const baseUrl = PTERODACTYL_PANEL_URL.replace(/\/+$/, '');
  const resourcesUrl = `${baseUrl}/api/client/servers/${PTERODACTYL_SERVER_ID}/resources`;
  const powerUrl = `${baseUrl}/api/client/servers/${PTERODACTYL_SERVER_ID}/power`;

  console.log(`🔌 [0/5] Pterodactyl 开机检测 ${PTERODACTYL_PANEL_URL} server=${PTERODACTYL_SERVER_ID}`);

  // 1. 查状态
  const status = await new Promise((resolve, reject) => {
    const req = https.request(resourcesUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${PTERODACTYL_API_KEY}`, 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve({ state: JSON.parse(data).attributes?.current_state || 'unknown', isSuspended: JSON.parse(data).attributes?.is_suspended || false }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });

  console.log(`  📊 当前状态: ${status.state} (suspended: ${status.isSuspended})`);

  if (status.state === 'running' || status.state === 'starting') {
    console.log('  ✅ 服务器已运行，跳过开机');
    return { state: status.state, action: 'none' };
  }

  if (status.isSuspended) {
    console.log('  ⚠️  服务器已挂起 (suspended)，无法开机');
    return { state: status.state, action: 'skipped_suspended' };
  }

  // 2. 发 start 信号
  console.log(`  🔘 状态为 ${status.state}，发送 start 信号...`);
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ signal: 'start' });
    const url = new URL(powerUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 204 || res.statusCode === 200) {
          console.log(`  ✅ start 信号已发送 (HTTP ${res.statusCode})`);
          resolve();
        } else {
          reject(new Error(`start 失败: HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('request timeout')); });
    req.write(body);
    req.end();
  });

  // 3. 等服务器起来（最多 60 秒）
  console.log('  ⏳ 等待服务器启动...');
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const s = await new Promise((resolve, reject) => {
        const req = https.request(resourcesUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${PTERODACTYL_API_KEY}`, 'Accept': 'application/json' },
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data).attributes?.current_state || 'unknown'); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      console.log(`    [${(i + 1) * 5}s] state: ${s}`);
      if (s === 'running') {
        console.log('  ✅ 服务器已成功启动');
        return { state: s, action: 'powered_on' };
      }
    } catch (e) {
      console.log(`    [${(i + 1) * 5}s] 检测失败: ${e.message}`);
    }
  }

  console.log('  ⚠️  服务器启动超时（60s），但继续执行保活');
  return { state: 'timeout', action: 'powered_on_maybe' };
}

test('OptikLink 自动登录保活', async ({}, testInfo) => {
  if (!DISCORD_TOKEN) throw new Error('❌ 缺少 DISCORD_TOKEN');

  // === [0/5] 开机检测（先于登录）===
  try {
    const powerStatus = await checkAndPowerOnServer();
    if (powerStatus.action && powerStatus.action !== 'none') {
      await sendTG(`🔌 OptikLink 服务器开机\n动作: ${powerStatus.action}\n状态: ${powerStatus.state || 'unknown'}\n时间: ${nowStr()}`);
    }
  } catch (powerErr) {
    console.error(`⚠️ 开机检测异常（继续保活）: ${powerErr.message}`);
  }

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

    // ── 4.5 处理 OptikLink 数学验证码（Quick Verification）────────
    // OAuth 回跳后可能落在 /login 并显示数学验证。解决后才会真正登录。
    await page.waitForTimeout(2000);
    const solved = await solveMathCaptcha(page);
    if (solved) {
      console.log('🧮 [3.5/5] 数学验证已解决，继续登录');
    }

    // ── 5. 确认到达 OptikLink ──────────────────────────────────────
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
