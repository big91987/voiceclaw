const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1257544?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找所有行，看 2.0 音色对应的 resource_id
  console.log('=== 查找 2.0 resource_id ===');
  const lines = text.split('\n');
  
  // 查找 uranus_bigtts 附近的信息
  lines.forEach((l, i) => {
    if (l.includes('uranus_bigtts') || l.includes('2.0') && (l.includes('resource') || l.includes('Resource'))) {
      console.log(`[${i}] ${l.trim()}`);
      // 打印前后几行
      for (let j = Math.max(0, i-2); j <= Math.min(lines.length-1, i+2); j++) {
        if (j !== i) console.log(`    ${lines[j].trim()}`);
      }
    }
  });
  
  await browser.close();
})();
