const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 查找音色列表文档
  await page.goto('https://www.volcengine.com/docs/6561/1259439'); // 音色列表文档
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 beijingxiaoye 和 resource 的对应关系
  const lines = text.split('\n').filter(l => 
    l.includes('beijingxiaoye') || l.includes('moon_bigtts') || 
    l.includes('resource') || l.includes('seed-tts')
  );
  
  console.log('=== 音色对应关系 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
