const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 API 端点和请求参数
  const lines = text.split('\n').filter(l => 
    l.includes('http') || l.includes('wss') || l.includes('api/') || 
    l.includes('Authorization') || l.includes('Bearer') || l.includes('token') ||
    l.includes('resource') || l.includes('endpoint') || l.includes('model')
  );
  
  console.log('=== 豆包语音 2.0 API 信息 ===');
  lines.slice(0, 60).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
