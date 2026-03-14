const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1257544?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  console.log('=== 文档前 200 行 ===');
  text.split('\n').slice(0, 200).forEach((l, i) => {
    if (l.trim()) console.log(`[${i}] ${l.trim()}`);
  });
  
  await browser.close();
})();
