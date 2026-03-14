const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1257584');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找请求参数示例
  const lines = text.split('\n').filter(l => 
    l.includes('resource') || l.includes('reqid') || l.includes('appid') ||
    l.includes('text') || l.includes('voice_type') || l.includes('{') || l.includes('}')
  );
  
  console.log('=== 请求参数 ===');
  lines.slice(0, 80).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
