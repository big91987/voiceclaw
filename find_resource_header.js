const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 查看 WebSocket 双向流式文档
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 X-Api-Resource-Id 的示例
  const lines = text.split('\n');
  
  console.log('=== X-Api-Resource-Id 示例 ===');
  lines.forEach((l, i) => {
    if (l.includes('X-Api-Resource') || l.includes('resource_id') || l.includes('seed-tts-2')) {
      console.log(`[${i}] ${l.trim()}`);
    }
  });
  
  await browser.close();
})();
