/**
 * 상세 API 및 DOM 분석 - 탭 클릭 시 발생하는 추가 API 호출 파악
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function analyze2() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const ktmRequests = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('ktmmobile.com') && ['xhr', 'fetch'].includes(req.resourceType())) {
      const postData = req.postData();
      ktmRequests.push({ url, method: req.method(), postData, time: Date.now() });
    }
  });

  const ktmResponses = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('ktmmobile.com') && ['xhr', 'fetch'].includes(res.request().resourceType())) {
      try {
        const body = await res.text();
        ktmResponses.push({ url, status: res.status(), body });
      } catch (_) {}
    }
  });

  console.log('페이지 접속...');
  await page.goto('https://www.ktmmobile.com/rate/rateList.do', {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(2000);

  // 현재까지 수집된 DOM 분석
  const initialState = await page.evaluate(() => {
    // 아코디언 아이템 구조 상세 분석
    const accordionItems = document.querySelectorAll('.c-accordion__item');
    const plans = [];
    accordionItems.forEach((item, idx) => {
      if (idx < 5) { // 처음 5개만
        plans.push({
          idx,
          title: item.querySelector('.product__title')?.textContent.trim(),
          html: item.innerHTML.substring(0, 1000)
        });
      }
    });

    // 메인 탭 정보
    const mainTabs = Array.from(document.querySelectorAll('#mainTab .c-tabs__button')).map(btn => ({
      id: btn.id,
      text: btn.textContent.trim(),
      active: btn.classList.contains('is-active'),
      dataset: { ...btn.dataset }
    }));

    // 서브 탭 (LTE/5G)
    const subTabs = Array.from(document.querySelectorAll('[id^="subTab_"]')).map(btn => ({
      id: btn.id,
      text: btn.textContent.trim(),
      active: btn.classList.contains('is-active'),
      dataset: { ...btn.dataset }
    }));

    // 필터 탭
    const filterTabs = Array.from(document.querySelectorAll('.c-tabs__list:not(#mainTab) .c-tabs__button')).map(btn => ({
      id: btn.id,
      text: btn.textContent.trim(),
      active: btn.classList.contains('is-active'),
      dataset: { ...btn.dataset }
    }));

    return { plans, mainTabs, subTabs, filterTabs, totalAccordions: accordionItems.length };
  });

  console.log('\n=== 초기 상태 ===');
  console.log('총 아코디언 항목:', initialState.totalAccordions);
  console.log('메인 탭:', JSON.stringify(initialState.mainTabs, null, 2));
  console.log('서브 탭:', JSON.stringify(initialState.subTabs, null, 2));
  console.log('필터 탭:', JSON.stringify(initialState.filterTabs, null, 2));
  console.log('첫 번째 요금제들:');
  initialState.plans.forEach(p => {
    console.log(`  [${p.idx}] ${p.title}`);
    console.log(`    HTML: ${p.html.substring(0, 300)}\n`);
  });

  // 5G 탭 클릭 시도
  console.log('\n=== 5G 탭 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  const subTab5G = await page.$('[id^="subTab_"]:not(.is-active)');
  if (subTab5G) {
    await subTab5G.click();
    await page.waitForTimeout(2000);
    console.log('5G 클릭 후 새 API 호출:');
    ktmRequests.forEach(r => console.log(`  ${r.method} ${r.url} | POST: ${r.postData || ''}`));
  }

  // 제휴 탭 클릭
  console.log('\n=== 제휴 탭 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  const partnerTab = await page.$('#rateListTab2');
  if (partnerTab) {
    await partnerTab.click();
    await page.waitForTimeout(2000);
    console.log('제휴 탭 클릭 후 새 API 호출:');
    ktmRequests.forEach(r => console.log(`  ${r.method} ${r.url} | POST: ${r.postData || ''}`));

    if (ktmResponses.length > 0) {
      console.log('\n제휴 탭 응답 샘플:');
      console.log(ktmResponses[0]?.body?.substring(0, 1000));
    }
  }

  // 휴대폰 탭 클릭
  console.log('\n=== 휴대폰 탭 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  const phoneTab = await page.$('#rateListTab3');
  if (phoneTab) {
    await phoneTab.click();
    await page.waitForTimeout(2000);
    console.log('휴대폰 탭 클릭 후 새 API 호출:');
    ktmRequests.forEach(r => console.log(`  ${r.method} ${r.url} | POST: ${r.postData || ''}`));
  }

  // accordion 첫번째 항목 클릭해서 상세 정보 확인
  console.log('\n=== 유심/eSIM 탭으로 돌아가서 첫 항목 클릭 ===');
  ktmRequests.length = 0;
  ktmResponses.length = 0;

  await page.$('#rateListTab1').then(el => el && el.click());
  await page.waitForTimeout(1500);

  const firstAccordionBtn = await page.$('.runtime-data-insert.c-accordion__button');
  if (firstAccordionBtn) {
    await firstAccordionBtn.click();
    await page.waitForTimeout(2000);
    console.log('아코디언 열기 후 API 호출:');
    ktmRequests.forEach(r => console.log(`  ${r.method} ${r.url} | POST: ${r.postData || ''}`));

    if (ktmResponses.length > 0) {
      console.log('\n아코디언 응답 샘플:');
      ktmResponses.forEach((r, i) => {
        console.log(`[${i}] ${r.url}`);
        console.log(r.body.substring(0, 1000));
        console.log('---');
      });
    }

    // 열린 아코디언 내용 분석
    const openedContent = await page.evaluate(() => {
      const openItem = document.querySelector('.c-accordion__item.is-active, .c-accordion__item[aria-expanded="true"]');
      if (!openItem) {
        // 첫 번째 콘텐츠 패널
        const panel = document.querySelector('.c-accordion__content');
        return panel ? panel.innerHTML.substring(0, 2000) : 'not found';
      }
      return openItem.innerHTML.substring(0, 2000);
    });
    console.log('\n열린 아코디언 HTML:');
    console.log(openedContent);
  }

  // 전체 초기 API 응답 저장
  fs.writeFileSync(
    '/Users/yeook/Documents/ktm-crawler/logs/analyze2_state.json',
    JSON.stringify(initialState, null, 2)
  );

  await browser.close();
}

analyze2().catch(console.error);
