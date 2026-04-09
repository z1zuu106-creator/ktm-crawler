/**
 * 스카이라이프 모바일 상세 DOM 분석
 */
const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // RSC API 응답 캡처
  const rscResponses = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('skylife') && url.includes('_rsc') && !url.includes('goods')) {
      try {
        const body = await res.text();
        rscResponses.push({ url, body: body.substring(0, 5000) });
      } catch (_) {}
    }
  });

  await page.goto('https://www.skylife.co.kr/product/mobile/all', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    // 전체 요금제 카드 수집 (중복 포함)
    const cards = document.querySelectorAll('a[href*="/product/mobile/goods/"]');
    const seen = new Set();
    const plans = [];

    cards.forEach(card => {
      const href = card.getAttribute('href');
      if (seen.has(href)) return;
      seen.add(href);

      // 슬러그 추출
      const slug = href.match(/\/goods\/([^/?#]+)/)?.[1] || '';

      // 카드 내 텍스트 요소들
      const allText = card.innerText || card.textContent || '';
      const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

      // 특정 요소 찾기
      const heading = card.querySelector('h2, h3, h4, strong, [class*="title"], [class*="name"]')?.textContent?.trim();

      // 가격 찾기 (월 XX,XXX원 패턴)
      const priceText = lines.find(l => l.match(/월\s*[\d,]+원/));
      const priceNum = priceText?.match(/[\d,]+/)?.shift()?.replace(/,/g, '');

      // 혜택가 찾기
      const benefitText = lines.find(l => l.match(/혜택가|할인가/));

      // 데이터 라인
      const dataLine = lines.find(l => l.match(/GB|MB|무제한/) && l.match(/데이터|\d/));

      // QoS 라인
      const qosLine = lines.find(l => l.match(/소진\s*후|Mbps|속도/));

      // 음성/문자
      const voiceLine = lines.find(l => l.match(/통화/));
      const smsLine = lines.find(l => l.match(/문자/));

      plans.push({
        slug,
        href,
        heading,
        allText: allText.substring(0, 400),
        lines: lines.slice(0, 15),
        priceText,
        priceNum,
        benefitText,
        dataLine,
        qosLine,
        voiceLine,
        smsLine,
        fullHTML: card.innerHTML.substring(0, 1000),
      });
    });

    return { planCount: plans.length, plans };
  });

  console.log('총 유니크 카드:', result.planCount);
  console.log('\n첫 5개 카드 상세:');
  result.plans.slice(0, 5).forEach((p, i) => {
    console.log(`\n[${i}] slug=${p.slug}`);
    console.log('  heading:', p.heading);
    console.log('  lines:', p.lines);
    console.log('  priceText:', p.priceText);
    console.log('  dataLine:', p.dataLine);
    console.log('  qosLine:', p.qosLine);
    console.log('  voiceLine:', p.voiceLine);
    console.log('  smsLine:', p.smsLine);
  });

  fs.writeFileSync('/Users/yeook/Documents/ktm-crawler/logs/skylife_detail.json',
    JSON.stringify(result, null, 2));
  console.log('\n저장 완료');

  await browser.close();
}

main().catch(console.error);
