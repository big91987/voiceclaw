const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找音色列表
  const lines = text.split('\n').filter(l => 
    l.includes('voice_type') || l.includes('音色') || l.includes('zh_') ||
    l.includes('male') || l.includes('female') || l.includes('BV')
  );
  
  console.log('=== 支持的音色 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
