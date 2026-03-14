const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  // 获取所有文本
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 API 相关信息
  const lines = text.split('\n').filter(l => 
    l.includes('http') || l.includes('wss') || l.includes('api/') || 
    l.includes('Authorization') || l.includes('Bearer') || l.includes('token')
  );
  
  console.log('=== API 信息 ===');
  lines.slice(0, 30).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
