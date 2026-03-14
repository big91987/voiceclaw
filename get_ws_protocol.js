const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 WebSocket 子协议或连接方式
  const lines = text.split('\n').filter(l => 
    l.includes('protocol') || l.includes('子协议') || l.includes('Sec-WebSocket') ||
    l.includes('binary') || l.includes('json')
  );
  
  console.log('=== WebSocket 协议信息 ===');
  lines.slice(0, 30).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
