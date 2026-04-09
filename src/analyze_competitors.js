/**
 * 경쟁사 3개 사이트 상세 분석
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function analyzeSite(browser, url, name, extractFn) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${name}] 분석 시작: ${url}`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const requests = [];
  const responses = [];

  page.on('request', req => {
    const u = req.url();
    const type = req.resourceType();
    if (['xhr', 'fetch'].includes(type) && !u.includes('google') && !u.includes('analytics') && !u.includes('facebook')) {
      requests.push({ url: u, method: req.method(), postData: req.postData() });
    }
  });

  page.on('response', async res => {
    const u = res.url();
    const type = res.request().resourceType();
    if (['xhr', 'fetch'].includes(type) && !u.includes('google') && !u.includes('analytics') && !u.includes('facebook')) {
      try {
        const body = await res.text();
        responses.push({ url: u, status: res.status(), body: body.substring(0, 3000) });
      } catch (_) {}
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log(`\n[${name}] XHR/Fetch 요청:`);
  requests.forEach((r, i) => {
    console.log(`  [${i}] ${r.method} ${r.url}`);
    if (r.postData) console.log(`       POST: ${r.postData.substring(0, 300)}`);
  });

  console.log(`\n[${name}] API 응답 샘플:`);
  responses.forEach((r, i) => {
    console.log(`  [${i}] ${r.status} ${r.url}`);
    console.log(`       ${r.body.substring(0, 500)}`);
  });

  const result = await extractFn(page);
  console.log(`\n[${name}] DOM 추출 결과:`);
  console.log(JSON.stringify(result, null, 2).substring(0, 3000));

  fs.writeFileSync(`/Users/yeook/Documents/ktm-crawler/logs/competitor_${name}.json`,
    JSON.stringify({ requests, responses, dom: result }, null, 2));

  await context.close();
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // 1. LG 헬로비전
  await analyzeSite(browser, 'https://direct.lghellovision.net/rate/rateViewUsim.do', 'lghello', async (page) => {
    return page.evaluate(() => {
      // 리스트 아이템 구조 분석
      const items = document.querySelectorAll('#rateList .list-item, #rateList li');
      const sample = [];
      items.forEach((item, i) => {
        if (i < 3) {
          sample.push({
            html: item.outerHTML.substring(0, 800),
            title: item.querySelector('h2, .plan-title, #mTitle')?.textContent?.trim(),
            net: item.querySelector('.net')?.textContent?.trim(),
            gan: item.querySelector('.gan')?.textContent?.trim(),
            call: item.querySelector('.call')?.textContent?.trim(),
            text: item.querySelector('.text')?.textContent?.trim(),
            price: item.querySelector('#priceNum, .priceNum, [id*="price"]')?.textContent?.trim(),
            dataset: { ...item.dataset }
          });
        }
      });

      // 필터 초기 script 변수
      const scripts = Array.from(document.scripts).map(s => s.textContent).join('\n');
      const telecomMatch = scripts.match(/reqTelecom['":\s]+(['"][\w]+['"])/);
      const rateTypeMatch = scripts.match(/reqRateType['":\s]+(['"][\w]+['"])/);

      return {
        itemCount: items.length,
        sample,
        telecom: telecomMatch?.[1],
        rateType: rateTypeMatch?.[1],
        bodyPreview: document.body.innerHTML.substring(0, 2000)
      };
    });
  });

  // 2. U+ 알뜰모바일
  await analyzeSite(browser, 'https://www.uplusumobile.com/product/pric/usim/pricList', 'uplus', async (page) => {
    return page.evaluate(() => {
      // bx-list 내 div들
      const items = document.querySelectorAll('#bx-list > div, .list-item, [class*="item"]');
      const sample = [];
      Array.from(items).slice(0, 5).forEach((item) => {
        sample.push({
          tagName: item.tagName,
          className: item.className.substring(0, 100),
          dataset: { ...item.dataset },
          text: item.textContent.trim().substring(0, 300),
          html: item.outerHTML.substring(0, 800)
        });
      });

      // __NEXT_DATA__ 또는 inline data
      const nextData = window.__NEXT_DATA__;
      const initialProps = nextData?.props?.pageProps;

      return {
        itemCount: items.length,
        sample,
        hasNextData: !!nextData,
        nextDataKeys: nextData ? Object.keys(nextData) : [],
        pagePropsKeys: initialProps ? Object.keys(initialProps) : [],
        listDataSample: initialProps?.list?.slice(0, 2) || initialProps?.planList?.slice(0, 2)
      };
    });
  });

  // 3. 스카이라이프
  await analyzeSite(browser, 'https://www.skylife.co.kr/product/mobile/all', 'skylife', async (page) => {
    return page.evaluate(() => {
      // Next.js 데이터
      const nextData = window.__NEXT_DATA__;
      const initialProps = nextData?.props?.pageProps;

      // 요금제 카드 찾기
      const cards = document.querySelectorAll('a[href*="/product/mobile/goods/"]');
      const sample = [];
      Array.from(cards).slice(0, 5).forEach(card => {
        sample.push({
          href: card.href,
          text: card.textContent.trim().substring(0, 300),
          html: card.outerHTML.substring(0, 500)
        });
      });

      // self.__next_f 데이터 (서버 컴포넌트 스트리밍)
      const scripts = Array.from(document.scripts).map(s => s.textContent).join('\n');
      const planDataMatch = scripts.match(/"planCd":"[^"]+"/g);

      return {
        cardCount: cards.length,
        sample,
        hasNextData: !!nextData,
        nextDataKeys: nextData ? Object.keys(nextData) : [],
        pagePropsKeys: initialProps ? Object.keys(initialProps) : [],
        pagePropsData: JSON.stringify(initialProps)?.substring(0, 2000),
        planCodes: planDataMatch?.slice(0, 5)
      };
    });
  });

  await browser.close();
  console.log('\n분석 완료!');
}

main().catch(console.error);
