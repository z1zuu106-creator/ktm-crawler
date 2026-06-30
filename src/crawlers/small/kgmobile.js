/**
 * KG모바일 요금제 크롤러 (중소사업자)
 * API: GET /api/product/plan/group → /api/product/plan?planGroupNo=XXX
 * 방식: Playwright 브라우저 세션으로 인증된 API 호출
 * URL: https://www.kgmobile.co.kr/plan
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.kgmobile.co.kr/plan';

const CARRIER_MAP = { LGT: 'LGU+', SKT: 'SKT', KT: 'KT' };

function parsePrice(val) {
  if (!val && val !== 0) return null;
  const n = parseInt(String(val).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseVoice(v) {
  const n = parseInt(v, 10);
  if (!v || n === 0) return '기본제공';
  if (n === -1) return '무제한';
  return `${n}분`;
}

function parseSms(v) {
  const n = parseInt(v, 10);
  if (!v || n === 0) return '기본제공';
  if (n === -1) return '무제한';
  return `${n}건`;
}

// contents HTML에서 할인 기간 추출 (saleList에 termMonth 없음)
function extractDiscountPeriod(contentsHtml) {
  if (!contentsHtml) return null;
  const m = contentsHtml.match(/가입월 포함 (\d+)개월|(\d+)개월간 적용/);
  if (m) return `${m[1] || m[2]}개월`;
  return null;
}

async function crawl(log = console.log) {
  log('  [KG모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);

  // 1. 요금제 그룹 목록 조회
  const groups = await page.evaluate(async () => {
    const r = await fetch('/api/product/plan/group?isUser=true&limit=-1&page=1');
    const json = await r.json();
    return (json.entity?.list || []).filter(g => g.useFlag === 'Y');
  });
  log(`  [KG모바일] 그룹 ${groups.length}개 수집`);

  const allPlans = [];
  const seenCodes = new Set();
  const collectedAt = new Date().toISOString();

  // 2. 그룹별 요금제 조회
  for (const group of groups) {
    const plans = await page.evaluate(async (groupNo) => {
      const r = await fetch(
        `/api/product/plan?isUser=true&limit=-1&orderType=DISPLAY_ORDER&page=1&planGroupNo=${groupNo}&useFlag=Y`
      );
      const json = await r.json();
      return json.entity?.list || [];
    }, group.planGroupNo);

    for (const item of plans) {
      const code = item.planCode || '';
      if (code && seenCodes.has(code)) continue;
      if (code) seenCodes.add(code);

      const planName = (item.planName || '').trim();
      if (!planName) continue;

      const basePrice = item.basicAmount || null;
      const sale = item.saleList?.[0];
      const prSale = sale?.prSaleAmount || 0;
      const ltSale = sale?.ltSaleAmount || 0;

      let monthlyFee = basePrice;
      let discountPeriod = '-';
      let priceAfterDiscount = null;

      if (prSale > 0) {
        monthlyFee = basePrice - prSale;
        discountPeriod = extractDiscountPeriod(item.contents) || '프로모션기간';
        priceAfterDiscount = ltSale > 0 ? basePrice - ltSale : basePrice;
      } else if (ltSale > 0) {
        monthlyFee = basePrice - ltSale;
        discountPeriod = '평생';
      }

      const networkType = item.network === '5G' ? '5G' : 'LTE';
      const data = item.basicMonthData
        ? `${item.basicMonthData}${item.basicMonthDataUnit || 'GB'}`
        : null;
      const qos = item.basicQos && item.basicQos !== '0' ? item.basicQos : null;

      allPlans.push({
        company:              'KG모바일',
        carrier:              CARRIER_MAP[item.telco] || item.telco || '',
        network_type:         networkType,
        plan_type:            '유심',
        plan_name:            planName,
        plan_code:            code,
        voice:                parseVoice(item.basicVoice),
        sms:                  parseSms(item.basicSms),
        data,
        qos,
        benefits:             '-',
        base_price:           basePrice,
        monthly_fee:          monthlyFee,
        price_after_discount: priceAfterDiscount,
        discount_period:      discountPeriod,
        source_url:           SOURCE_URL,
        collected_at:         collectedAt,
        _operator:            'kgmobile',
      });
    }
  }

  await browser.close();
  log(`  [KG모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
