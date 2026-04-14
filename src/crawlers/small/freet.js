/**
 * 프리티 요금제 크롤러 (중소사업자)
 * API: GET https://api.freet.co.kr/plan/v1/list?rowSize=20&pageNo=N&onlineAuth=Y
 * 분류: 유심 전용
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.freet.co.kr/plan/ratePlan';
const API_BASE = 'https://api.freet.co.kr/plan/v1/list';
const PAGE_SIZE = 20;

// comType → 통신사
const CARRIER_MAP = {
  freeS: 'SKT',
  freeC: 'KT',
  freeT: 'LGU+',
};

/**
 * freeVoice: "기본제공" | "300분" | "무제한" → 숫자 또는 문자
 * 반환: 숫자(분), "무제한", "기본제공"
 */
function parseVoice(val) {
  if (!val) return '기본제공';
  val = val.trim();
  if (val === '무제한') return '무제한';
  if (val === '기본제공') return '기본제공';
  const m = val.match(/^(\d+)분/);
  return m ? Number(m[1]) : val;
}

/**
 * freeSms: "기본제공" | "100건" | "무제한"
 * 반환: 숫자(건), "무제한", "기본제공"
 */
function parseSms(val) {
  if (!val) return '기본제공';
  val = val.trim();
  if (val === '무제한') return '무제한';
  if (val === '기본제공') return '기본제공';
  const m = val.match(/^(\d+)건/);
  return m ? Number(m[1]) : val;
}

/**
 * freeData: "월100GB" | "월7GB+추가10GB" | "월11GB+매일2GB" | "무제한"
 * 반환: "100GB", "7GB+추가10GB" 등 월(月) 접두어 제거
 */
function parseData(val) {
  if (!val) return null;
  val = val.trim();
  if (val === '무제한') return '무제한';
  return val.replace(/^월/, '').trim() || val;
}

/**
 * 할인기간 판별
 * - periodDiscMonth > 0: "N개월" (기간 한정 프로모션)
 * - periodDiscMonth = 0 && foreverDiscAmt > 0: "평생"
 * - 둘 다 0: "-"
 */
function buildDiscountPeriod(periodDiscMonth, foreverDiscAmt) {
  if (periodDiscMonth > 0) return `${periodDiscMonth}개월`;
  if (foreverDiscAmt > 0) return '평생';
  return '-';
}

/**
 * 할인 후 금액 (할인기간 종료 후 납부 금액)
 * - periodDiscMonth > 0: basicFee - foreverDiscAmt (평생할인만 남음, 없으면 정가)
 * - periodDiscMonth = 0: null (이미 현재가가 영구가)
 */
function buildPriceAfterDiscount(basicFee, periodDiscMonth, foreverDiscAmt) {
  if (!periodDiscMonth || periodDiscMonth === 0) return null;
  const base = parseInt(basicFee, 10) || 0;
  return base - (foreverDiscAmt || 0);
}

async function fetchAllPlans(page, totalCount) {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const all = [];

  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    const res = await page.evaluate(async ({ apiBase, pageNo, pageSize }) => {
      const r = await fetch(`${apiBase}?rowSize=${pageSize}&pageNo=${pageNo}&onlineAuth=Y&_=${Date.now()}`, {
        headers: { 'Referer': 'https://www.freet.co.kr/plan/ratePlan' }
      });
      return r.json();
    }, { apiBase: API_BASE, pageNo, pageSize: PAGE_SIZE });

    const list = res.data?.ratePlans || [];
    all.push(...list);
  }

  return all;
}

async function crawl(log = console.log) {
  log('  [프리티] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 초기 페이지 로드 (브라우저 세션 확보)
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1500);

  // 전체 건수 파악 (1페이지로)
  const firstRes = await page.evaluate(async ({ apiBase, pageSize }) => {
    const r = await fetch(`${apiBase}?rowSize=${pageSize}&pageNo=1&onlineAuth=Y&_=${Date.now()}`, {
      headers: { 'Referer': 'https://www.freet.co.kr/plan/ratePlan' }
    });
    return r.json();
  }, { apiBase: API_BASE, pageSize: PAGE_SIZE });

  const totalCount = firstRes.data?.totalCount || 0;
  log(`  [프리티] 총 ${totalCount}건 확인, 페이지네이션 시작...`);

  const firstPage = firstRes.data?.ratePlans || [];
  const restPages = totalCount > PAGE_SIZE
    ? await fetchAllPlans(page, totalCount).then(all => all.slice(PAGE_SIZE))
    : [];
  const rawItems = [...firstPage, ...restPages];

  await browser.close();
  log(`  [프리티] ${rawItems.length}건 수신`);

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of rawItems) {
    const code = item.svcCd || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = item.svcName?.trim() || '';
    if (!planName) continue;

    const carrier = CARRIER_MAP[item.comType] || item.comType || '';
    const networkType = item.genCd === '5G' ? '5G' : 'LTE';

    const voice = parseVoice(item.freeVoice);
    const sms = parseSms(item.freeSms);
    const data = parseData(item.freeData);

    const basePrice = parseInt(item.basicFee, 10) || null;
    const monthlyFee = parseInt(item.monthlyFee, 10) || null;

    // 추가혜택: benefits 배열의 이름 목록
    const benefits = Array.isArray(item.benefits)
      ? item.benefits.map(b => b.beneName).filter(Boolean).join(',')
      : '';

    const discountPeriod = buildDiscountPeriod(
      item.periodDiscMonth || 0,
      item.foreverDiscAmt || 0
    );
    const priceAfterDiscount = buildPriceAfterDiscount(
      item.basicFee,
      item.periodDiscMonth || 0,
      item.foreverDiscAmt || 0
    );

    allPlans.push({
      company: '프리티',
      carrier,
      network_type: networkType,
      plan_type: '유심',
      plan_name: planName,
      plan_code: code,
      voice,              // 음성/분
      sms,                // 문자/건
      data,               // 데이터/GB
      qos: item.qos || null,
      benefits,           // 추가혜택
      base_price: basePrice,                  // 기본료(정가)
      monthly_fee: monthlyFee,                // 당일 요금(할인가)
      price_after_discount: priceAfterDiscount, // 할인 후 금액 (기간 종료 후)
      discount_period: discountPeriod,        // 할인기간
      source_url: SOURCE_URL,
      collected_at: new Date().toISOString(),
      _operator: 'freet',
    });
  }

  log(`  [프리티] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
