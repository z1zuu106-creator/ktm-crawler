/**
 * 아이즈모바일 요금제 크롤러 (중소사업자)
 * API: POST https://www.eyes.co.kr/payplan/get_PlanList
 * 방식: Playwright 브라우저 세션으로 POST 호출
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.eyes.co.kr/payplan/info2';
const API_PATH = '/payplan/get_PlanList';

// telco → 통신사
const CARRIER_MAP = {
  KT:   'KT',
  LGT:  'LGU+',
  SKT:  'SKT',
};

/**
 * 5G망 요금제 판별
 * "[L]5G 데이터안심", "[S]5G 울트라" 등은 5G
 * "아이즈포스트(500분/5G)", "1.5G" 등 GB 표기는 LTE
 * 조건: 5G 앞이 공백/괄호/대괄호이고, 뒤가 공백/한글/괄호 또는 끝
 */
function is5G(name) {
  return /(?:^|[\s\[\]])5G(?=[\s가-힣(]|$)/.test(name);
}

/**
 * 음성 제공량
 * basic_add_flag=Y: 부가음성(basic_add_txt)이 실제 제공 음성
 * 그 외: basic_voice_txt 사용
 */
function parseVoice(item) {
  if (item.basic_add_flag === 'Y') {
    return item.basic_add_txt || '기본제공';
  }
  const txt = item.basic_voice_txt?.trim();
  if (!txt || txt === '0분') return '기본제공';
  return txt;
}

/**
 * 문자 제공량
 * "0건"은 기본제공으로 처리
 */
function parseSms(item) {
  const txt = item.basic_sms_txt?.trim();
  if (!txt || txt === '0건') return '기본제공';
  return txt;
}

/**
 * 할인기간
 * dc_forever=true(dc_period=9999): "평생"
 * dc_period>0: "N개월"
 * dc_period=0: "-"
 */
function buildDiscountPeriod(item) {
  if (item.dc_forever) return '평생';
  const period = parseInt(item.dc_period, 10);
  if (period > 0) return `${period}개월`;
  return '-';
}

/**
 * 할인 후 금액 (기간 할인 종료 후 납부 금액)
 * dc_type="1" (기간 한정): 기간 후 basic_fee로 복귀
 * dc_type="2" (평생): 변동 없음 → null
 * 할인 없음: null
 */
function buildPriceAfterDiscount(item) {
  if (item.dc_type !== '1') return null;
  return parseInt(item.basic_fee, 10) || null;
}

/**
 * 추가혜택: goods_explain_text1~4 중 비어있지 않은 것을 결합
 */
function parseBenefits(item) {
  return [item.goods_explain_text1, item.goods_explain_text2, item.goods_explain_text3, item.goods_explain_text4]
    .map(t => (t || '').trim())
    .filter(Boolean)
    .join(' / ') || '-';
}

async function crawl(log = console.log) {
  log('  [아이즈모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 브라우저 세션 확보 (쿠키, 세션키 등)
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1500);

  // POST API 호출
  const apiData = await page.evaluate(async (apiPath) => {
    const r = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return r.json();
  }, API_PATH);

  await browser.close();

  const rawList = apiData?.planList || [];
  log(`  [아이즈모바일] ${rawList.length}건 수신 (전체: ${apiData?.totalCnt}건)`);

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of rawList) {
    const code = item.prod_cd || item.payplan_seq || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = item.service_name?.trim() || '';
    if (!planName) continue;

    const carrier = CARRIER_MAP[item.telco] || item.telco_nm || item.telco || '';
    const networkType = is5G(planName) ? '5G' : 'LTE';
    const basePrice = parseInt(item.basic_fee, 10) || null;
    const monthlyFee = parseInt(item.sale_price, 10) || basePrice;

    allPlans.push({
      company: '아이즈모바일',
      carrier,
      network_type: networkType,
      plan_type: '유심',
      plan_name: planName,
      plan_code: code,
      voice:               parseVoice(item),
      sms:                 parseSms(item),
      data:                item.basic_data_txt || null,
      qos:                 item.data_qos || null,
      benefits:            parseBenefits(item),
      base_price:          basePrice,
      monthly_fee:         monthlyFee,
      price_after_discount: buildPriceAfterDiscount(item),
      discount_period:     buildDiscountPeriod(item),
      source_url:          SOURCE_URL,
      collected_at:        new Date().toISOString(),
      _operator:           'eyez',
    });
  }

  log(`  [아이즈모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
