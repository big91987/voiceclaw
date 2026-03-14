const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n');
  const keys = ['audio only request', '最后一包', 'NegativeSeq', 'PositiveSeq', 'gzip', '压缩', 'sequence', 'format', 'codec'];
  for (let i = 0; i < lines.length; i++) {
    if (keys.some(k => lines[i].toLowerCase().includes(k.toLowerCase()) || lines[i].includes(k))) {
      console.log(`\n[${i}] ${lines[i].trim()}`);
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        if (lines[j].trim()) console.log(`  ${lines[j].trim()}`);
      }
    }
  }
  await browser.close();
})();