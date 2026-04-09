/**
 * 스카이라이프 개별 요금제 상세 페이지 분석
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // RSC 응답 캡처 (개별 상품 페이지)
  const goodsResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/product/mobile/goods/') && url.includes('_rsc')) {
      try {
        const body = await res.text();
        goodsResponses.push({ url, body });
      } catch (_) {}
    }
  });

  // 샘플 요금제 페이지 로드 (5G 모두 충분 200GB+)
  await page.goto('https://www.skylife.co.kr/product/mobile/goods/pl234d620', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(3000);

  const planDetail = await page.evaluate(() => {
    const allText = document.body.innerText;
    const html = document.body.innerHTML;

    // 요금 관련 요소들 찾기
    const priceEls = Array.from(document.querySelectorAll('[class*="price"], [class*="fee"], [class*="amount"]'))
      .slice(0, 10).map(el => ({ class: el.className, text: el.textContent.trim().substring(0, 100) }));

    // 데이터, QoS, 음성 관련 요소
    const detailEls = Array.from(document.querySelectorAll('[class*="detail"], [class*="spec"], [class*="info"], [class*="data"]'))
      .slice(0, 10).map(el => ({ class: el.className.substring(0, 50), text: el.textContent.trim().substring(0, 100) }));

    // 텍스트 라인 추출 (의미있는 것들)
    const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length < 100);

    return { priceEls, detailEls, lines: lines.slice(0, 50), htmlPreview: html.substring(0, 5000) };
  });

  console.log('=== 가격 관련 요소 ===');
  planDetail.priceEls.forEach(e => console.log('  ', e.class, ':', e.text));

  console.log('\n=== 상세 관련 요소 ===');
  planDetail.detailEls.forEach(e => console.log('  ', e.class, ':', e.text));

  console.log('\n=== 텍스트 라인 ===');
  planDetail.lines.forEach((l, i) => console.log(`  [${i}] ${l}`));

  console.log('\n=== HTML 미리보기 (3000자) ===');
  console.log(planDetail.htmlPreview.substring(0, 3000));

  fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/skylife_goods_detail.json',
    JSON.stringify(planDetail, null, 2));

  // 두 번째 요금제도 확인
  await page.goto('https://www.skylife.co.kr/product/mobile/goods/pl231k975', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(2000);

  const plan2 = await page.evaluate(() => {
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length < 200);
    return { lines: lines.slice(0, 40) };
  });
  console.log('\n=== 두 번째 요금제 텍스트 라인 ===');
  plan2.lines.forEach((l, i) => console.log(`  [${i}] ${l}`));

  await browser.close();
}

main().catch(console.error);
