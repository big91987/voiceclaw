const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Message flow') || lines[i].includes('客户发送 3 个请求') || lines[i].includes('StartConnection') || lines[i].includes('StartSession') || lines[i].includes('audio only client request')) {
      console.log(`\n[${i}] ${lines[i].trim()}`);
      for (let j = i; j < Math.min(lines.length, i + 30); j++) {
        if (lines[j].trim()) console.log(lines[j].trim());
      }
      console.log('---');
    }
  }
  await browser.close();
})();