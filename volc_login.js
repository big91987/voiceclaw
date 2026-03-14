const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  
  console.log('Opening 火山云登录页...');
  await page.goto('https://console.volcengine.com/auth/login/');
  
  // 等待二维码加载
  await page.waitForTimeout(3000);
  
  // 截图二维码区域
  const qrCode = await page.locator('.qr-code, .login-qr, [class*="qr"], img[alt*="二维码"]').first();
  
  if (await qrCode.isVisible().catch(() => false)) {
    await qrCode.screenshot({ path: '/tmp/volc_qrcode.png' });
    console.log('✅ 二维码已保存到 /tmp/volc_qrcode.png');
  } else {
    // 截整个页面
    await page.screenshot({ path: '/tmp/volc_login.png', fullPage: false });
    console.log('✅ 登录页已截图 /tmp/volc_login.png');
  }
  
  // 等待登录成功
  console.log('等待扫码登录...');
  try {
    await page.waitForURL('**/console**', { timeout: 120000 });
    console.log('✅ 登录成功!');
    await page.screenshot({ path: '/tmp/volc_logged_in.png' });
    console.log('已截图登录后页面');
  } catch (e) {
    console.log('等待超时或登录未完成');
  }
  
  await browser.close();
})();
