const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 req_params 的完整结构
  console.log('=== 查找 req_params 结构 ===');
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('req_params') && lines[i].includes('{')) {
      // 打印 req_params 的完整 JSON 结构
      console.log(`\n[${i}] Found req_params:`);
      for (let j = i; j < Math.min(lines.length, i+50); j++) {
        console.log(lines[j].trim());
        if (lines[j].includes('}') && j > i) break;
      }
    }
  }
  
  await browser.close();
})();
