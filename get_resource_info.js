const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 resource_id 和音色的对应关系
  const lines = text.split('\n').filter(l => 
    l.includes('resource') || l.includes(' Resource') || l.includes('资源') ||
    l.includes('seed-tts') || l.includes('mars') || l.includes('bigtts')
  );
  
  console.log('=== Resource ID 信息 ===');
  lines.slice(0, 40).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
