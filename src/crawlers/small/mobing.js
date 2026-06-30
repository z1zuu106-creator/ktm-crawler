/**
 * 모빙 요금제 크롤러 (중소사업자)
 * API: GET https://www.mobing.co.kr/api/product/getPlanList?page=1&limit=300
 * 방식: Playwright 브라우저 세션으로 GET 호출
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.mobing.co.kr/product/plan4';
const API_PATH   = '/api/product/getPlanList?page=1&limit=300';

// telco → 통신사
const CARRIER_MAP = {
  SKT: 'SKT',
  KT:  'KT',
  LGT: 'LGU+',
};

/**
 * 음성 제공량
 * basicVoice = 0 → 기본제공
 */
function parseVoice(item) {
  if (!item.basicVoice || item.basicVoice === 0) return '기본제공';
  return `${item.basicVoice}분`;
}

/**
 * 문자 제공량
 * basicSms = 0 → 기본제공
 */
function parseSms(item) {
  if (!item.basicSms || item.basicSms === 0) return '기본제공';
  return `${item.basicSms}건`;
}

/**
 * 데이터 제공량
 * basicDataMon + basicDataMonUnit
 */
function parseData(item) {
  const amt  = item.basicDataMon;
  const unit = item.basicDataMonUnit || 'GB';
  if (!amt) return null;
  if (String(amt).toLowerCase() === '무제한') return '무제한';
  return `${amt}${unit}`;
}

/**
 * QoS
 * basicQos + basicQosUnit
 */
function parseQos(item) {
  const q = item.basicQos;
  if (!q || q === '0') return null;
  return `${q}${item.basicQosUnit || 'Mbps'}`;
}

/**
 * 프로모션 정보 분석
 * promoSaleList[0].saleList 에서
 *  - termMonth < 1200 인 항목 → 기간 할인 (N개월)
 *  - termMonth = 1200      → 평생 할인 (ltSaleAmount)
 *
 * 반환:
 *  { monthly_fee, discount_period, price_after_discount }
 */
function buildPromo(item) {
  const basePrice = item.amountMon || 0;
  const promo     = item.promoSaleList?.[0];

  if (!promo) {
    return { monthly_fee: basePrice, discount_period: '-', price_after_discount: null };
  }

  const ltSale = parseInt(promo.ltSaleAmount, 10) || 0;
  const prSale = parseInt(promo.prSaleAmount, 10) || 0;

  // 기간 한정 프로모션 할인
  if (prSale > 0) {
    // 기간 할인 termMonth 찾기 (1200 미만)
    const periodEntry = (promo.saleList || []).find(s => parseInt(s.termMonth, 10) < 1200);
    const periodMonths = periodEntry ? parseInt(periodEntry.termMonth, 10) : 0;

    const discountPeriod    = periodMonths > 0 ? `${periodMonths}개월` : '-';
    const monthlyFee        = basePrice - prSale;
    // 기간 종료 후: 평생 할인이 있으면 그 가격, 없으면 정가
    const priceAfterDiscount = periodMonths > 0
      ? (ltSale > 0 ? basePrice - ltSale : basePrice)
      : null;

    return { monthly_fee: monthlyFee, discount_period: discountPeriod, price_after_discount: priceAfterDiscount };
  }

  // 평생 할인만 있는 경우
  if (ltSale > 0) {
    return {
      monthly_fee:          basePrice - ltSale,
      discount_period:      '평생',
      price_after_discount: null,
    };
  }

  return { monthly_fee: basePrice, discount_period: '-', price_after_discount: null };
}

async function crawl(log = console.log) {
  log('  [모빙] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);

  const apiData = await page.evaluate(async (apiPath) => {
    const r = await fetch(apiPath);
    return r.json();
  }, API_PATH);

  await browser.close();

  const rawList = apiData?.entity?.list || [];
  const total   = apiData?.entity?.pageInfo?.totalRow || rawList.length;
  log(`  [모빙] ${rawList.length}건 수신 (전체: ${total}건)`);

  const allPlans  = [];
  const seenCodes = new Set();

  for (const item of rawList) {
    const code = item.planID || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = item.planNM?.trim() || '';
    if (!planName) continue;

    const carrier     = CARRIER_MAP[item.telco] || item.telco || '';
    const networkType = item.networkID === '5G' ? '5G' : 'LTE';
    const basePrice   = item.amountMon || null;

    const { monthly_fee, discount_period, price_after_discount } = buildPromo(item);

    allPlans.push({
      company:              '모빙',
      carrier,
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            planName,
      plan_code:            code,
      voice:                parseVoice(item),
      sms:                  parseSms(item),
      data:                 parseData(item),
      qos:                  parseQos(item),
      benefits:             '-',
      base_price:           basePrice,
      monthly_fee,
      price_after_discount,
      discount_period,
      source_url:           SOURCE_URL,
      collected_at:         new Date().toISOString(),
      _operator:            'mobing',
    });
  }

  log(`  [모빙] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
