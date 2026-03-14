const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1257544?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 uranus_bigtts 的章节标题
  const lines = text.split('\n');
  
  console.log('=== uranus_bigtts 所在章节 ===');
  lines.forEach((l, i) => {
    if (l.includes('uranus_bigtts')) {
      // 往前找章节标题
      for (let j = Math.max(0, i-20); j < i; j++) {
        if (lines[j].includes('模型') || lines[j].includes('版本') || lines[j].includes('音色列表')) {
          console.log(`[${j}] ${lines[j].trim()}`);
        }
      }
      console.log(`[${i}] ${l.trim()}`);
      console.log('---');
    }
  });
  
  await browser.close();
})();
