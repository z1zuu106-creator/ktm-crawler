/**
 * 핀다이렉트 요금제 크롤러 (중소사업자)
 * API: GET https://z-api.pindirectshop.com/product/deal?page=0&size=200
 * 방식: Playwright 브라우저 세션으로 GET 호출
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.pindirectshop.com/deal-list';
const API_URL    = 'https://z-api.pindirectshop.com/product/deal?page=0&size=200';

/**
 * MB → GB 변환
 * 100000 → "100GB" / 11000 → "11GB" / 2000(일일) → 별도 처리
 */
function mbToGb(mb) {
  if (!mb || mb === 0) return null;
  const gb = mb / 1000;
  return gb % 1 === 0 ? `${gb}GB` : `${gb.toFixed(1)}GB`;
}

/**
 * kbps → Mbps 변환
 * 5000 kbps → "5Mbps" / 3000 → "3Mbps"
 */
function kbpsToMbps(kbps) {
  if (!kbps || kbps === 0) return null;
  const mbps = kbps / 1000;
  return mbps % 1 === 0 ? `${mbps}Mbps` : `${mbps.toFixed(1)}Mbps`;
}

/**
 * 음성 제공량
 * voice = -1 → 무제한 / 0 → 기본제공 / N → N분
 */
function parseVoice(voice) {
  if (voice === -1) return '무제한';
  if (!voice || voice === 0) return '기본제공';
  return `${voice}분`;
}

/**
 * 문자 제공량
 * message = -1 → 무제한 / 0 → 기본제공 / N → N건
 */
function parseSms(message) {
  if (message === -1) return '무제한';
  if (!message || message === 0) return '기본제공';
  return `${message}건`;
}

/**
 * 데이터 제공량
 * basicData (MB) + dailyData (MB, 일일 추가) 조합
 * 예: 11000 + 2000 → "11GB+매일2GB"
 */
function parseData(plan) {
  const basic = plan?.basicData;
  const daily = plan?.dailyData;
  if (!basic && !daily) return null;

  const basicStr = basic ? mbToGb(basic) : null;
  const dailyStr = (daily && daily > 0) ? `매일${mbToGb(daily)}` : null;

  if (basicStr && dailyStr) return `${basicStr}+${dailyStr}`;
  return basicStr || dailyStr || null;
}

/**
 * 할인 구조 분석
 * discountPeriod > 0 + discountPrice > 0  → 기간 할인 (N개월)
 * discountPeriod = 0 + lifetimeDiscount > 0 → 평생 할인
 *
 * 반환: { monthly_fee, discount_period, price_after_discount }
 */
function buildDiscount(price, discountPrice, discountPeriod, lifetimeDiscountPrice) {
  // 기간 한정 할인
  if (discountPeriod > 0 && discountPrice > 0) {
    const monthlyFee = price - discountPrice;
    // 기간 후: 평생 할인이 있으면 그 가격, 없으면 정가
    const priceAfterDiscount = lifetimeDiscountPrice > 0
      ? price - lifetimeDiscountPrice
      : price;
    return {
      monthly_fee:          monthlyFee,
      discount_period:      `${discountPeriod}개월`,
      price_after_discount: priceAfterDiscount,
    };
  }

  // 평생 할인
  if (lifetimeDiscountPrice > 0) {
    return {
      monthly_fee:          price - lifetimeDiscountPrice,
      discount_period:      '평생',
      price_after_discount: null,
    };
  }

  // 할인 없음
  return {
    monthly_fee:          price,
    discount_period:      '-',
    price_after_discount: null,
  };
}

async function crawl(log = console.log) {
  log('  [핀다이렉트] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);

  const apiData = await page.evaluate(async (apiUrl) => {
    const r = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
    });
    return r.json();
  }, API_URL);

  await browser.close();

  const rawList = apiData?.list || apiData?.content || [];
  const total   = apiData?.total || rawList.length;
  log(`  [핀다이렉트] ${rawList.length}건 수신 (전체: ${total}건)`);

  const allPlans  = [];
  const seenCodes = new Set();

  for (const item of rawList) {
    const code = item.planViewCode || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = item.name?.trim() || '';
    if (!planName) continue;

    const carrier     = item.planProvider || item.plan?.provider || '';
    const networkType = item.plan?.network === '5G' ? '5G' : 'LTE';
    const basePrice   = item.price || null;

    const { monthly_fee, discount_period, price_after_discount } = buildDiscount(
      item.price || 0,
      item.discountPrice || 0,
      item.discountPeriod || 0,
      item.lifetimeDiscountPrice || 0
    );

    // 혜택
    const benefits = Array.isArray(item.benefits)
      ? item.benefits.map(b => b.name).filter(Boolean).join(' / ')
      : '-';

    allPlans.push({
      company:              '핀다이렉트',
      carrier,
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            planName,
      plan_code:            code,
      voice:                parseVoice(item.plan?.voice),
      sms:                  parseSms(item.plan?.message),
      data:                 parseData(item.plan),
      qos:                  kbpsToMbps(item.plan?.qos),
      benefits,
      base_price:           basePrice,
      monthly_fee,
      price_after_discount,
      discount_period,
      source_url:           SOURCE_URL,
      collected_at:         new Date().toISOString(),
      _operator:            'pindirect',
    });
  }

  log(`  [핀다이렉트] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
