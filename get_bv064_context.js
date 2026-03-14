const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1259439');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n');
  
  // 查找 BV064 的上下文
  const idx = lines.findIndex(l => l.includes('BV064'));
  if (idx >= 0) {
    console.log('=== BV064 上下文 ===');
    for (let i = Math.max(0, idx-3); i <= Math.min(lines.length-1, idx+3); i++) {
      console.log(`[${i}] ${lines[i].trim()}`);
    }
  } else {
    console.log('BV064 not found in document');
  }
  
  await browser.close();
})();
