const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 2.0 的 resource_id 和音色的对应关系
  const lines = text.split('\n').filter(l => 
    l.includes('2.0') && (l.includes('resource') || l.includes('音色') || l.includes('voice'))
  );
  
  console.log('=== 2.0 Resource ID & 音色 ===');
  lines.slice(0, 30).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
