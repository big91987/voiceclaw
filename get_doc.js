const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Opening 豆包语音 2.0 文档...');
  await page.goto('https://www.volcengine.com/docs/6561/1354869?lang=zh');
  
  await page.waitForTimeout(5000);
  
  // 获取页面文本内容
  const content = await page.content();
  
  // 查找 API 端点
  const ttsMatch = content.match(/https?:\/\/[^\s\"]+tts[^\s\"]*/i);
  const asrMatch = content.match(/wss?:\/\/[^\s\"]+asr[^\s\"]*/i);
  
  console.log('TTS API:', ttsMatch ? ttsMatch[0] : 'Not found');
  console.log('ASR API:', asrMatch ? asrMatch[0] : 'Not found');
  
  // 截图
  await page.screenshot({ path: '/tmp/doubao_doc.png', fullPage: true });
  console.log('✅ 文档已截图 /tmp/doubao_doc.png');
  
  await browser.close();
})();
