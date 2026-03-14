const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 查找音色列表
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 saturn 开头的音色
  const lines = text.split('\n').filter(l => 
    l.includes('saturn_') || (l.includes('2.0') && l.includes('音色'))
  );
  
  console.log('=== 2.0 音色列表 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
