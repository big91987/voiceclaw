const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 ASR API 信息
  const lines = text.split('\n').filter(l => 
    l.includes('wss') || l.includes('api') || l.includes('resource') ||
    l.includes('bidirection') || l.includes('bigmodel') || l.includes('Header')
  );
  
  console.log('=== ASR 2.0 API 信息 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
