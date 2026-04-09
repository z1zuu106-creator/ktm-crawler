/**
 * 스카이라이프 전체 요금제 수 확인 - 스크롤/더보기/탭 분석
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  // API 요청 캡처
  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('skylife') && !url.includes('analytics') && !url.includes('clarity')) {
      apiCalls.push({ method: req.method(), url, postData: req.postData() });
    }
  });

  await page.goto('https://www.skylife.co.kr/product/mobile/all', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(2000);

  // 초기 상태 분석
  const initial = await page.evaluate(() => {
    const cards = document.querySelectorAll('a[href*="/product/mobile/goods/"]');
    const seen = new Set();
    cards.forEach(a => seen.add(a.getAttribute('href')));

    // 필터 버튼들
    const filters = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.textContent.trim().length > 0 && b.textContent.trim().length < 20)
      .map(b => ({ text: b.textContent.trim(), class: b.className?.substring(0, 60) }))
      .slice(0, 30);

    // 총 개수 텍스트
    const countText = document.body.innerText.match(/총\s*[\d,]+개/)?.[0];

    // 더보기 버튼
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b =>
      b.textContent.includes('더보기') || b.textContent.includes('더 보기') || b.textContent.includes('load')
    );

    // 페이지네이션
    const pagination = document.querySelector('[class*="pagination"], [class*="paging"]');

    return {
      uniqueLinks: seen.size,
      countText,
      hasMoreBtn: !!moreBtn,
      moreBtnText: moreBtn?.textContent?.trim(),
      hasPagination: !!pagination,
      filters,
      bodyTextPreview: document.body.innerText.substring(0, 500)
    };
  });

  console.log('초기 카드 수:', initial.uniqueLinks);
  console.log('페이지 총 개수 텍스트:', initial.countText);
  console.log('더보기 버튼:', initial.hasMoreBtn, initial.moreBtnText);
  console.log('페이지네이션:', initial.hasPagination);
  console.log('필터 버튼들:', initial.filters);
  console.log('본문 미리보기:', initial.bodyTextPreview);

  // 페이지 끝까지 스크롤 (lazy loading 체크)
  console.log('\n=== 스크롤 테스트 ===');
  let prevCount = initial.uniqueLinks;
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(500);
    const count = await page.evaluate(() => {
      const seen = new Set();
      document.querySelectorAll('a[href*="/product/mobile/goods/"]').forEach(a => seen.add(a.getAttribute('href')));
      return seen.size;
    });
    if (count !== prevCount) {
      console.log(`스크롤 ${i+1}회 후 카드 수: ${count}`);
      prevCount = count;
    }
  }
  console.log('스크롤 후 최종 카드 수:', prevCount);

  // 각 필터 탭 클릭 시 카드 수 변화
  console.log('\n=== 필터 탭별 카드 수 ===');
  const filterNames = ['라이프핏', '데이터 무제한', '통화 무제한', '만원 이하', '시니어', '주니어', '실속 요금제', '5G+', '안심', '스마트기기', '복지 전용'];

  const allSlugs = new Set();

  // 먼저 전체보기 슬러그 수집
  const initialSlugs = await page.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('a[href*="/product/mobile/goods/"]').forEach(a => {
      const m = a.getAttribute('href')?.match(/\/goods\/([^/?#]+)/);
      if (m) seen.add(m[1]);
    });
    return [...seen];
  });
  initialSlugs.forEach(s => allSlugs.add(s));
  console.log('전체보기 슬러그:', initialSlugs.length, '개');

  for (const filterName of filterNames) {
    try {
      // 필터 버튼 클릭
      const clicked = await page.evaluate((name) => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], li, span'));
        const btn = btns.find(b => b.textContent.trim() === name);
        if (btn) { btn.click(); return true; }
        return false;
      }, filterName);

      if (!clicked) { console.log(`  [${filterName}]: 버튼 없음`); continue; }
      await page.waitForTimeout(800);

      const slugs = await page.evaluate(() => {
        const seen = new Set();
        document.querySelectorAll('a[href*="/product/mobile/goods/"]').forEach(a => {
          const m = a.getAttribute('href')?.match(/\/goods\/([^/?#]+)/);
          if (m) seen.add(m[1]);
        });
        return [...seen];
      });

      slugs.forEach(s => allSlugs.add(s));
      console.log(`  [${filterName}]: ${slugs.length}개`);

    } catch (e) {
      console.log(`  [${filterName}]: 오류 - ${e.message.substring(0, 50)}`);
    }
  }

  console.log(`\n전체 필터 순회 후 총 유니크 슬러그: ${allSlugs.size}개`);
  console.log('슬러그 목록:', [...allSlugs]);

  fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/skylife_all_slugs.json',
    JSON.stringify([...allSlugs], null, 2));

  // API 호출 확인
  const skylifeCalls = apiCalls.filter(r => r.url.includes('skylife') && !r.url.includes('cdn'));
  console.log('\n=== 스카이라이프 API 호출 ===');
  skylifeCalls.slice(0, 20).forEach(r => console.log(' ', r.method, r.url.substring(0, 100)));

  await browser.close();
}

main().catch(console.error);
