const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找代码示例
  const lines = text.split('\n').filter(l => 
    l.includes('const ws') || l.includes('new WebSocket') || 
    l.includes('ws.send') || l.includes('onmessage') ||
    l.includes('import') || l.includes('require')
  );
  
  console.log('=== 代码示例 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
