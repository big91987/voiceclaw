const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找音频格式相关信息
  const lines = text.split('\n').filter(l => 
    l.includes('format') || l.includes('采样率') || l.includes('pcm') || 
    l.includes('mp3') || l.includes('音频') || l.includes('编码')
  );
  
  console.log('=== 音频格式信息 ===');
  lines.slice(0, 50).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
