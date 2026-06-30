/**
 * 모나 요금제 크롤러 (중소사업자)
 * API: POST /common/component/plan/AjaxRate_plan.aspx
 * URL: https://mobilemona.co.kr/view/plan/rate_plan.aspx
 * 응답 필드: GDCD, GDNM, GDDESC, SEEDATA, SEEVOICE, SEELETTER,
 *            EVENT_PERIOD, TT_AMT, DISCOUNT, MNO_CD, NETDIV
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://mobilemona.co.kr/view/plan/rate_plan.aspx';
const AJAX_PATH  = '/common/component/plan/AjaxRate_plan.aspx';

function parsePrice(str) {
  if (!str && str !== 0) return null;
  const n = parseInt(String(str).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseVoice(v) {
  if (!v) return '기본제공';
  if (v === '무제한' || v === '-1') return '무제한';
  return v.trim();
}

function parseSms(v) {
  if (!v) return '기본제공';
  if (v === '무제한' || v === '-1') return '무제한';
  return v.trim();
}

function parseData(v) {
  if (!v) return null;
  if (/무제한/.test(v)) return '무제한';
  return v.trim() || null;
}

async function crawl(log = console.log) {
  log('  [모나] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 30000 });

  const rawData = await page.evaluate(async (ajaxPath) => {
    const r = await fetch(ajaxPath, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ header: [{ type: '01' }], body: [{ e_agcd: '', keywordSeq: '' }] }),
    });
    const json = await r.json();
    return json.DATA || [];
  }, AJAX_PATH);

  await browser.close();
  log(`  [모나] ${rawData.length}건 수신`);

  if (rawData.length === 0) throw new Error('요금제 데이터 없음');

  const allPlans = [];
  const seenCodes = new Set();
  const collectedAt = new Date().toISOString();

  for (const item of rawData) {
    const code = item.GDCD || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = (item.GDNM || '').trim();
    if (!planName) continue;

    const basePrice  = parsePrice(item.TT_AMT);
    const discount   = parsePrice(item.DISCOUNT);
    const eventPeriod = (item.EVENT_PERIOD || '').trim();

    let monthlyFee = basePrice;
    let discountPeriod = '-';
    let priceAfterDiscount = null;

    if (discount > 0 && eventPeriod) {
      const periodNum = parseInt(eventPeriod, 10);
      monthlyFee       = Math.max(0, basePrice - discount);
      discountPeriod   = periodNum >= 1200 ? '평생' : `${eventPeriod}개월`;
      priceAfterDiscount = discountPeriod === '평생' ? null : basePrice;
    }

    const networkType = (item.NETDIV || '').toUpperCase() === '5G' ? '5G' : 'LTE';

    allPlans.push({
      company:              '모나',
      carrier:              item.MNO_CD || 'LGU+',
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            planName,
      plan_code:            code,
      voice:                parseVoice(item.SEEVOICE),
      sms:                  parseSms(item.SEELETTER),
      data:                 parseData(item.SEEDATA),
      qos:                  null,
      benefits:             item.GDDESC || '-',
      base_price:           basePrice,
      monthly_fee:          monthlyFee,
      price_after_discount: priceAfterDiscount,
      discount_period:      discountPeriod,
      source_url:           SOURCE_URL,
      collected_at:         collectedAt,
      _operator:            'mona',
    });
  }

  log(`  [모나] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
