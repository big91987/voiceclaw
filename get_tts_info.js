const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // TTS 文档
  await page.goto('https://www.volcengine.com/docs/6561/1359370?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  const lines = text.split('\n').filter(l => 
    l.includes('http') || l.includes('api/') || 
    l.includes('Authorization') || l.includes('Bearer')
  );
  
  console.log('=== TTS API 信息 ===');
  lines.slice(0, 30).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
