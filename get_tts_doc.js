const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1257584');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 API 端点和认证信息
  const lines = text.split('\n').filter(l => 
    l.includes('http') || l.includes('wss') || l.includes('api/') || 
    l.includes('Authorization') || l.includes('Bearer') || l.includes('token') ||
    l.includes('请求地址') || l.includes('接口')
  );
  
  console.log('=== TTS API 信息 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
