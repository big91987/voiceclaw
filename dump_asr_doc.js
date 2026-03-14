const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  const text = await page.evaluate(() => document.body.innerText);
  require('fs').writeFileSync('asr_doc_dump.txt', text);
  console.log('dumped');
  await browser.close();
})();