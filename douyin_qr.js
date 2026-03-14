const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  
  // 直接打开抖音扫码登录页
  console.log('Opening 抖音扫码登录...');
  await page.goto('https://open.douyin.com/platform/oauth/connect/?client_key=awp6a7e9z5v81r7p&response_type=code&scope=user_info&redirect_uri=https%3A%2F%2Fconsole.volcengine.com%2Fauth%2Fcallback%2Fdouyin');
  
  await page.waitForTimeout(3000);
  
  // 截图
  await page.screenshot({ path: '/tmp/douyin_qr.png', fullPage: false });
  console.log('✅ 已截图 /tmp/douyin_qr.png');
  
  // 等待扫码
  console.log('等待扫码 (60秒)...');
  await page.waitForTimeout(60000);
  
  await browser.close();
})();
