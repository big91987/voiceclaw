const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1259439');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找所有 bigtts 音色，并看上下文是否有 2.0 标识
  const lines = text.split('\n');
  
  console.log('=== 所有 bigtts 音色 ===');
  lines.forEach((l, i) => {
    if (l.includes('bigtts') && l.includes('zh_')) {
      // 打印前后几行看上下文
      console.log(`\n[${i}] ${l.trim()}`);
      if (lines[i-1]) console.log(`  prev: ${lines[i-1].trim().substring(0, 80)}`);
      if (lines[i+1]) console.log(`  next: ${lines[i+1].trim().substring(0, 80)}`);
    }
  });
  
  await browser.close();
})();
