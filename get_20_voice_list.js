const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 音色列表文档
  await page.goto('https://www.volcengine.com/docs/6561/1259439');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 2.0 相关的音色
  const lines = text.split('\n').filter(l => 
    (l.includes('2.0') || l.includes('seed-tts')) && l.includes('zh_')
  );
  
  console.log('=== 2.0 音色列表 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
