const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找完整的请求示例和参数
  console.log('=== 查找请求示例 ===');
  const lines = text.split('\n');
  
  // 查找包含 "req_params" 或请求示例的部分
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('req_params') || lines[i].includes('请求参数') || lines[i].includes('示例')) {
      console.log(`[${i}] ${lines[i].trim()}`);
      // 打印前后几行
      for (let j = Math.max(0, i-3); j <= Math.min(lines.length-1, i+5); j++) {
        if (j !== i) console.log(`    ${lines[j].trim()}`);
      }
      console.log('---');
    }
  }
  
  await browser.close();
})();
