/**
 * 페이지 네트워크 요청 및 DOM 구조 분석 스크립트
 * 실제 크롤러 구현 전에 API 엔드포인트와 DOM 셀렉터를 파악한다.
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function analyze() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const networkRequests = [];

  // 모든 XHR/Fetch 요청 캡처
  page.on('request', (req) => {
    const url = req.url();
    const method = req.method();
    const resourceType = req.resourceType();
    if (['xhr', 'fetch'].includes(resourceType)) {
      const postData = req.postData();
      networkRequests.push({ url, method, resourceType, postData });
    }
  });

  const apiResponses = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('ktmmobile.com') && ['xhr', 'fetch'].includes(res.request().resourceType())) {
      try {
        const body = await res.text();
        apiResponses.push({ url, status: res.status(), body: body.substring(0, 2000) });
      } catch (_) {}
    }
  });

  console.log('페이지 접속 중...');
  await page.goto('https://www.ktmmobile.com/rate/rateList.do', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  // 추가 로딩 대기
  await page.waitForTimeout(3000);

  console.log('\n=== 네트워크 요청 목록 ===');
  networkRequests.forEach((r, i) => {
    console.log(`[${i+1}] ${r.method} ${r.url}`);
    if (r.postData) console.log(`    POST: ${r.postData.substring(0, 200)}`);
  });

  console.log('\n=== API 응답 샘플 ===');
  apiResponses.forEach((r, i) => {
    console.log(`[${i+1}] ${r.status} ${r.url}`);
    console.log(`    응답: ${r.body.substring(0, 500)}`);
    console.log('---');
  });

  // DOM 구조 분석
  const domInfo = await page.evaluate(() => {
    const results = {};

    // 요금제 카드 찾기
    const possibleCardSelectors = [
      '.rate-item', '.plan-item', '.prod-item', '.item', '.card',
      '[class*="rate"]', '[class*="plan"]', '[class*="prod"]',
      'li', '.list-item'
    ];

    for (const sel of possibleCardSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length < 100) {
        results[sel] = {
          count: els.length,
          firstHTML: els[0].outerHTML.substring(0, 500)
        };
      }
    }

    // 필터 탭 찾기
    const tabs = document.querySelectorAll('[role="tab"], .tab, .filter, button');
    results['tabs'] = Array.from(tabs).slice(0, 20).map(t => ({
      tag: t.tagName,
      text: t.textContent.trim().substring(0, 50),
      class: t.className,
      id: t.id
    }));

    // body innerHTML 일부
    results['bodyPreview'] = document.body.innerHTML.substring(0, 3000);

    return results;
  });

  console.log('\n=== DOM 분석 ===');
  console.log(JSON.stringify(domInfo, null, 2));

  // 결과 저장
  fs.writeFileSync(
    '/Users/yeook/Documents/ktm-crawler/logs/analyze_result.json',
    JSON.stringify({ networkRequests, apiResponses, domInfo }, null, 2)
  );
  console.log('\n분석 결과 저장: logs/analyze_result.json');

  await browser.close();
}

analyze().catch(console.error);
