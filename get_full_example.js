const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n');
  
  // 查找 SQL 示例或完整请求示例
  console.log('=== 查找完整请求示例 ===');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('SQL') || lines[i].includes('完整示例') || 
        (lines[i].includes('{') && lines[i+1]?.includes('user'))) {
      console.log(`\n[${i}] Context:`);
      for (let j = Math.max(0, i-2); j < Math.min(lines.length, i+30); j++) {
        if (lines[j].trim()) console.log(`  ${lines[j].trim()}`);
      }
      console.log('---');
    }
  }
  
  await browser.close();
})();
