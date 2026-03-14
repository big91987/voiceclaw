const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Opening 火山云文档...');
  
  // 豆包语音文档
  await page.goto('https://www.volcengine.com/docs/6561/1359370');
  
  console.log('Page loaded. Waiting for content...');
  await page.waitForTimeout(5000);
  
  // 获取页面内容
  const content = await page.content();
  console.log('Page content length:', content.length);
  
  // 查找 API 相关信息
  const ttsApi = await page.locator('text=/tts/i').first();
  const asrApi = await page.locator('text=/asr/i').first();
  
  console.log('TTS element found:', await ttsApi.isVisible().catch(() => false));
  console.log('ASR element found:', await asrApi.isVisible().catch(() => false));
  
  // 保持浏览器打开以便查看
  console.log('Browser will stay open for 60 seconds...');
  await page.waitForTimeout(60000);
  
  await browser.close();
})();
