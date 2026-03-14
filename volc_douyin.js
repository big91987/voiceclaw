const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  
  console.log('Opening 火山云登录页...');
  await page.goto('https://console.volcengine.com/auth/login/');
  await page.waitForTimeout(3000);
  
  // 点击抖音登录图标
  const douyinBtn = await page.locator('img[alt*="抖音"], [title*="抖音"], .login-icon-douyin').first();
  if (await douyinBtn.isVisible().catch(() => false)) {
    await douyinBtn.click();
    console.log('点击抖音登录');
    await page.waitForTimeout(3000);
  }
  
  // 截图二维码
  await page.screenshot({ path: '/tmp/volc_qr.png', fullPage: false });
  console.log('✅ 已截图 /tmp/volc_qr.png');
  
  // 等待扫码
  console.log('等待扫码登录 (60秒)...');
  await page.waitForTimeout(60000);
  
  await browser.close();
})();
