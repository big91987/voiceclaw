const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1259439');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n');
  
  // 查找 xueayi 的上下文
  const idx = lines.findIndex(l => l.includes('zh_female_xueayi_saturn_bigtts'));
  if (idx >= 0) {
    console.log('=== zh_female_xueayi_saturn_bigtts 上下文 ===');
    for (let i = Math.max(0, idx-5); i <= Math.min(lines.length-1, idx+5); i++) {
      console.log(`[${i}] ${lines[i].trim()}`);
    }
  }
  
  await browser.close();
})();
