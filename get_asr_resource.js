const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 resource_id 相关信息
  console.log('=== Resource ID 信息 ===');
  const lines = text.split('\n').filter(l => 
    l.includes('resource') || l.includes('Resource') || l.includes('RESOURCE') ||
    l.includes('X-Api-Resource') || l.includes('bigasr') || l.includes('10029')
  );
  
  lines.slice(0, 30).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
