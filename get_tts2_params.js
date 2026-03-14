const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.volcengine.com/docs/6561/1329505?lang=zh');
  await page.waitForTimeout(5000);
  
  const text = await page.evaluate(() => document.body.innerText);
  
  // 查找 resource_id 相关信息
  const lines = text.split('\n').filter(l => 
    l.includes('resource') || l.includes('cluster') || l.includes('appid') ||
    l.includes('请求参数') || l.includes('请求地址')
  );
  
  console.log('=== 请求参数详情 ===');
  lines.slice(0, 100).forEach(l => console.log(l.trim()));
  
  await browser.close();
})();
