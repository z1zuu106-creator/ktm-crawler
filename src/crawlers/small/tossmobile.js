/**
 * 토스모바일 요금제 크롤러 (중소사업자)
 * API: GET https://api-public.toss.im/api/v3/mvno-growth/products/homepage
 * 방식: Playwright 브라우저 세션으로 GET 호출
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://tossmobile.co.kr/pricing';
const API_URL    = 'https://api-public.toss.im/api/v3/mvno-growth/products/homepage';

/**
 * planCode 앞부분으로 통신사 추출
 * "SKT_5G_250GB" → SKT
 * "KT_5G_200GB"  → KT
 * 나머지          → LGU+
 */
function parseCarrier(planCode) {
  if (!planCode) return '';
  if (planCode.startsWith('SKT_')) return 'SKT';
  if (planCode.startsWith('KT_'))  return 'KT';
  if (planCode.startsWith('LG_') || planCode.startsWith('U_') || planCode.startsWith('LGU')) return 'LGU+';
  // 코드 앞부분이 3자리 대문자인 경우 그대로 사용
  const m = planCode.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}

/**
 * 음성 제공량
 * callUsage.type = "UNLIMITED" → "무제한"
 * callUsage.type = "LIMITED"   → "N분"
 */
function parseVoice(callUsage) {
  if (!callUsage) return '기본제공';
  if (callUsage.type === 'UNLIMITED') return '무제한';
  if (callUsage.type === 'LIMITED') {
    const amt = callUsage.basicAmount || callUsage.amount;
    return amt ? `${amt}분` : '기본제공';
  }
  return '기본제공';
}

/**
 * 문자 제공량
 * messageUsage.type = "UNLIMITED" → "무제한"
 */
function parseSms(messageUsage) {
  if (!messageUsage) return '기본제공';
  if (messageUsage.type === 'UNLIMITED') return '무제한';
  if (messageUsage.type === 'LIMITED') {
    const amt = messageUsage.basicAmount || messageUsage.amount;
    return amt ? `${amt}건` : '기본제공';
  }
  return '기본제공';
}

/**
 * 데이터 제공량
 * dataUsage.basicAmount (GB 문자열), type=UNLIMITED → "무제한"
 */
function parseData(dataUsage) {
  if (!dataUsage) return null;
  if (dataUsage.type === 'UNLIMITED') return '무제한';
  const amt = dataUsage.basicAmount;
  if (!amt) return null;
  return `${amt}GB`;
}

/**
 * QoS
 * dataUsage.speedLimit + speedLimitUnit
 */
function parseQos(dataUsage) {
  if (!dataUsage?.speedLimit) return null;
  return `${dataUsage.speedLimit}${dataUsage.speedLimitUnit || 'Mbps'}`;
}

/**
 * 할인 정책 분석
 * discountPolicyList: [{amount, numberOfMonths, ...}]
 * - numberOfMonths > 0: 기간 할인
 * - amount만 있고 numberOfMonths 없거나 매우 큰 경우: 평생
 *
 * 반환: { monthly_fee, discount_period, price_after_discount }
 */
function buildDiscount(monthlyFee, discountPolicyList) {
  if (!discountPolicyList || discountPolicyList.length === 0) {
    return { monthly_fee: monthlyFee, discount_period: '-', price_after_discount: null };
  }

  // 가장 큰 할인 정책을 주 할인으로 사용
  const primary = discountPolicyList.reduce(
    (max, p) => (p.amount > max.amount ? p : max),
    discountPolicyList[0]
  );

  const discAmt  = primary.amount    || 0;
  const nMonths  = primary.numberOfMonths;

  if (!discAmt) {
    return { monthly_fee: monthlyFee, discount_period: '-', price_after_discount: null };
  }

  // 평생 여부: numberOfMonths 없거나 매우 큰 경우 (≥ 1200)
  const isForever = !nMonths || nMonths >= 1200;

  if (isForever) {
    return {
      monthly_fee:          monthlyFee - discAmt,
      discount_period:      '평생',
      price_after_discount: null,
    };
  }

  return {
    monthly_fee:          monthlyFee - discAmt,
    discount_period:      `${nMonths}개월`,
    price_after_discount: monthlyFee, // 기간 종료 후 정가
  };
}

async function crawl(log = console.log) {
  log('  [토스모바일] 페이지 로딩 중...');

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

  const rawList = apiData?.success || [];
  log(`  [토스모바일] ${rawList.length}건 수신`);

  const allPlans  = [];
  const seenCodes = new Set();

  for (const item of rawList) {
    const code = item.code || String(item.id) || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = item.displayName?.trim() || '';
    if (!planName) continue;

    const carrier     = parseCarrier(item.planCode);
    const networkType = item.network === '5G' ? '5G' : 'LTE';
    const basePrice   = item.monthlyFee || null;

    const { monthly_fee, discount_period, price_after_discount } =
      buildDiscount(basePrice, item.discountPolicyList);

    allPlans.push({
      company:              '토스모바일',
      carrier,
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            planName,
      plan_code:            code,
      voice:                parseVoice(item.callUsage),
      sms:                  parseSms(item.messageUsage),
      data:                 parseData(item.dataUsage),
      qos:                  parseQos(item.dataUsage),
      benefits:             '-',
      base_price:           basePrice,
      monthly_fee,
      price_after_discount,
      discount_period,
      source_url:           SOURCE_URL,
      collected_at:         new Date().toISOString(),
      _operator:            'tossmobile',
    });
  }

  log(`  [토스모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
