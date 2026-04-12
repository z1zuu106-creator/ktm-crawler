/**
 * SK세븐모바일 요금제 크롤러
 * 방식: Playwright로 SSR 페이지 파싱
 * URL: https://www.sk7mobile.com/prod/data/callingPlanList.do?refCode=USIM
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.sk7mobile.com/prod/data/callingPlanList.do?refCode=USIM';

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

async function crawl(log = console.log) {
  log('  [SK세븐모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(2000);

  const rawItems = await page.evaluate(() => {
    const results = [];

    // 목록형: a.planItem
    document.querySelectorAll('a.planItem').forEach(el => {
      const onclickAttr = el.getAttribute('onclick') || '';
      const codeMatch = onclickAttr.match(/fnSearchView\('([^']+)'\)/);
      const code = codeMatch ? codeMatch[1] : '';

      const planName = el.querySelector('.name')?.textContent?.trim() || '';

      // 배지 텍스트 (QoS, 추가데이터 등)
      const badges = Array.from(el.querySelectorAll('.badge-wp span')).map(s => s.textContent.trim());

      // 서비스 목록: 데이터, 음성, 문자
      const serviceItems = Array.from(el.querySelectorAll('ul.service li')).map(li => li.textContent.trim());

      // 가격: .data-price strong
      const priceText = el.querySelector('.price strong, .data-price strong')?.textContent?.trim() || '';

      // 할인 전 가격: .sale-price (있을 경우)
      const salePriceText = el.querySelector('.sale-price, .cost-pre b, .origin-price')?.textContent?.trim() || '';

      results.push({ code, planName, badges, serviceItems, priceText, salePriceText });
    });

    return results;
  });

  await browser.close();

  log(`  [SK세븐모바일] ${rawItems.length}건 추출`);

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of rawItems) {
    if (!item.planName) continue;
    if (item.code && seenCodes.has(item.code)) continue;
    if (item.code) seenCodes.add(item.code);

    // serviceItems: [데이터, 음성, 문자] 순서
    const dataText = item.serviceItems[0] || '';
    const voiceText = item.serviceItems[1] || '기본제공';
    const smsText = item.serviceItems[2] || '기본제공';

    const { raw: data_allowance_raw, normalized: data_allowance_normalized } = buildData(dataText);
    const { qos_speed, qos_raw } = buildQoS(item.badges, item.planName);

    // 가격 파싱: "월 42,000원" → 42000
    const basePrice = parsePrice(item.priceText.replace('월', ''));
    const salePrice = item.salePriceText ? parsePrice(item.salePriceText) : null;
    // salePriceText가 있고 basePrice보다 크면 → salePriceText가 원래가, basePrice가 혜택가
    const isBenefitDiff = salePrice !== null && salePrice > (basePrice || 0);

    const network = item.planName.includes('5G') ? '5G' : 'LTE';

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
      plan_type: ['유심'],
      partnership_flag: false,
      network_type: network,
      product_group: '전체',
      source_url: SOURCE_URL,
      collected_at: new Date().toISOString(),
      _operator: 'sk7mobile',
    });
  }

  log(`  [SK세븐모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
