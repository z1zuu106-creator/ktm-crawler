/**
 * 아코디언 클릭 후 요금제 상세 데이터 구조 분석
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function analyze3() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const ktmRequests = [];
  const ktmResponses = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('ktmmobile.com') && ['xhr', 'fetch'].includes(req.resourceType())) {
      const postData = req.postData();
      ktmRequests.push({ url, method: req.method(), postData });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('ktmmobile.com') && ['xhr', 'fetch'].includes(res.request().resourceType())) {
      try {
        const body = await res.text();
        ktmResponses.push({ url, status: res.status(), body });
      } catch (_) {}
    }
  });

  await page.goto('https://www.ktmmobile.com/rate/rateList.do', {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(2000);

  // 초기 getCtgXmlAllListAjax 응답 저장
  const ctgResponse = ktmResponses.find(r => r.url.includes('getCtgXmlAllListAjax'));
  if (ctgResponse) {
    fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/ctg_response.json', ctgResponse.body);
    const ctgData = JSON.parse(ctgResponse.body);
    console.log('카테고리 API 응답 첫 아이템 키들:', Object.keys(ctgData[0]));
    console.log('총 카테고리 항목 수:', ctgData.length);
    console.log('첫 5개 항목:');
    ctgData.slice(0, 5).forEach((item, i) => {
      console.log(`[${i}]`, JSON.stringify(item, null, 2));
    });
  }

  // 첫 번째 아코디언 버튼 클릭
  console.log('\n=== 첫 번째 아코디언 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  // 보이는 아코디언 버튼 찾기
  const accordionBtn = page.locator('.c-accordion__item').first().locator('.c-accordion__button');
  await accordionBtn.click({ timeout: 10000 });
  await page.waitForTimeout(3000);

  console.log('아코디언 클릭 후 API 호출:');
  ktmRequests.forEach(r => {
    console.log(`  ${r.method} ${r.url}`);
    if (r.postData) console.log(`    POST: ${r.postData}`);
  });

  if (ktmResponses.length > 0) {
    console.log('\n아코디언 응답:');
    ktmResponses.forEach((r, i) => {
      console.log(`[${i}] ${r.url}`);
      console.log(r.body.substring(0, 2000));
      fs.writeFileSync(`/Users/yeook/Documents/ktm-crawler/logs/accordion_response_${i}.json`, r.body);
    });
  }

  // 열린 패널 HTML 분석
  const panelHTML = await page.evaluate(() => {
    const openPanel = document.querySelector('.c-accordion__content.is-active') ||
                      document.querySelector('.c-accordion__item.is-active .c-accordion__content') ||
                      document.querySelector('.c-accordion__content[style*="display"]') ||
                      document.querySelector('.c-accordion__content');

    if (openPanel) {
      return {
        found: true,
        class: openPanel.className,
        html: openPanel.innerHTML
      };
    }
    return { found: false, allPanels: Array.from(document.querySelectorAll('.c-accordion__content')).length };
  });

  console.log('\n=== 열린 패널 분석 ===');
  if (panelHTML.found) {
    console.log('패널 HTML (처음 3000자):');
    console.log(panelHTML.html.substring(0, 3000));
    fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/panel_html.html', panelHTML.html);
  } else {
    console.log('패널 못찾음. 전체 패널 수:', panelHTML.allPanels);

    // 전체 아코디언 영역 HTML 저장
    const fullAccordion = await page.evaluate(() => {
      const acc = document.querySelector('.c-accordion');
      return acc ? acc.innerHTML : document.querySelector('[id^="accordionproduct"]')?.innerHTML || 'not found';
    });
    console.log('전체 아코디언 HTML (처음 2000자):');
    console.log(fullAccordion.substring(0, 2000));
    fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/accordion_html.html', fullAccordion);
  }

  // 두 번째 아코디언 클릭해서 확인
  console.log('\n=== 두 번째 아코디언 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  const secondBtn = page.locator('.c-accordion__item').nth(1).locator('.c-accordion__button');
  try {
    await secondBtn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);

    if (ktmResponses.length > 0) {
      console.log('두 번째 아코디언 API 응답:');
      ktmResponses.forEach((r, i) => {
        console.log(`[${i}] ${r.url}`);
        const preview = r.body.substring(0, 2000);
        console.log(preview);
        fs.writeFileSync(`/Users/yeook/Documents/ktm-crawler/logs/accordion2_response_${i}.json`, r.body);
      });
    } else {
      console.log('추가 API 호출 없음 - 데이터가 이미 DOM에 있을 수 있음');
    }
  } catch (e) {
    console.log('두 번째 아코디언 클릭 실패:', e.message.substring(0, 100));
  }

  // 전체 HTML 저장 (디버깅용)
  const fullHTML = await page.content();
  fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/full_page.html', fullHTML);
  console.log('\n전체 페이지 HTML 저장됨: logs/full_page.html');

  await browser.close();
}

analyze3().catch(console.error);
