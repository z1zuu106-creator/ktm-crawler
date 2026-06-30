/**
 * SK세븐모바일 요금제 크롤러
 * 방식: Playwright로 SSR 페이지 파싱
 * URL: 유심 + 휴대폰 모두 수집
 */

const { chromium } = require('playwright');

const URLS = [
  { url: 'https://www.sk7mobile.com/prod/data/callingPlanList.do?refCode=USIM', planType: '유심' },
  { url: 'https://www.sk7mobile.com/prod/data/callingPlanList.do?refCode=PHONE&searchOrderby=1', planType: '휴대폰' },
];

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[,\s원월]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function buildData(dataText) {
  if (!dataText) return { raw: null, normalized: null };
  const s = dataText.trim();
  if (!s || s === '-') return { raw: null, normalized: null };
  return { raw: s, normalized: s };
}

function buildQoS(badgeTexts, planName) {
  // badge 텍스트에서 Mbps 추출 (예: "5Mbps", "+20GB5Mbps" 형태)
  for (const t of badgeTexts) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
    if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: t };
  }
  // 요금제명에서도 확인 (예: "1Mbps")
  const m2 = planName.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m2) return { qos_speed: `${m2[1]}${m2[2]}`, qos_raw: planName };
  return { qos_speed: null, qos_raw: null };
}

async function fetchFromUrl(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a.planItem').forEach(el => {
      const onclickAttr = el.getAttribute('onclick') || '';
      const codeMatch = onclickAttr.match(/fnSearchView\('([^']+)'\)/);
      const code = codeMatch ? codeMatch[1] : '';
      const planName = el.querySelector('.name')?.textContent?.trim() || '';
      const badges = Array.from(el.querySelectorAll('.badge-wp span')).map(s => s.textContent.trim());
      const serviceItems = Array.from(el.querySelectorAll('ul.service li')).map(li => li.textContent.trim());
      const priceText = el.querySelector('.price strong, .data-price strong')?.textContent?.trim() || '';
      const salePriceText = el.querySelector('.sale-price, .cost-pre b, .origin-price')?.textContent?.trim() || '';
      results.push({ code, planName, badges, serviceItems, priceText, salePriceText });
    });
    return results;
  });
}

async function crawl(log = console.log) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const allPlans = [];
  const seenCodes = new Set();

  for (const { url, planType } of URLS) {
    log(`  [SK세븐모바일] ${planType} 요금제 로딩 중...`);
    const rawItems = await fetchFromUrl(page, url);
    log(`  [SK세븐모바일] ${planType} ${rawItems.length}건 추출`);

    for (const item of rawItems) {
      if (!item.planName) continue;
      if (item.code && seenCodes.has(item.code)) continue;
      if (item.code) seenCodes.add(item.code);

      const dataText = item.serviceItems[0] || '';
      const voiceText = item.serviceItems[1] || '기본제공';
      const smsText = item.serviceItems[2] || '기본제공';

      const { raw: data_allowance_raw, normalized: data_allowance_normalized } = buildData(dataText);
      const { qos_speed, qos_raw } = buildQoS(item.badges, item.planName);

      const basePrice = parsePrice(item.priceText.replace('월', ''));
      const salePrice = item.salePriceText ? parsePrice(item.salePriceText) : null;
      const isBenefitDiff = salePrice !== null && salePrice > (basePrice || 0);

      // "15GB", "5GB" 등 데이터 크기 표기는 제외하고 실제 5G 망 표기만 감지
    // (?<!\d) : 앞에 숫자 없음 / (?!B) : 뒤에 B 없음 (GB 제외)
    const network = /(?<!\d)5G(?!B)/.test(item.planName) ? '5G' : 'LTE';

      allPlans.push({
        plan_name: item.planName,
        plan_code: item.code,
        data_allowance_raw,
        data_allowance_normalized,
        qos_raw,
        qos_speed,
        voice_allowance: voiceText || '기본제공',
        sms_allowance: smsText || '기본제공',
        base_price_text: basePrice ? `월 ${basePrice.toLocaleString()}원` : null,
        base_price: isBenefitDiff ? salePrice : basePrice,
        benefit_price_text: isBenefitDiff ? `혜택가 월 ${basePrice.toLocaleString()}원` : null,
        benefit_price: isBenefitDiff ? basePrice : null,
        plan_type: [planType],
        partnership_flag: false,
        network_type: network,
        product_group: '전체',
        source_url: url,
        collected_at: new Date().toISOString(),
        _operator: 'sk7mobile',
      });
    }
  }

  await browser.close();
  log(`  [SK세븐모바일] 최종 ${allPlans.length}건 (중복 제거 후)`);
  return allPlans;
}

module.exports = { crawl };
