const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找协议版本相关信息
  const lines = text.split('\n').filter(l => 
    l.includes('version') || l.includes('版本') || l.includes('protocol') ||
    l.includes('v3') || l.includes('V3') || l.includes('WebSocket')
  );
  
  console.log('=== 协议版本信息 ===');
  lines.slice(0, 40).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
