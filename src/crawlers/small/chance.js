/**
 * 찬스모바일 요금제 크롤러 (중소사업자)
 * API: POST /common/component/plan/AjaxPhone_plan.aspx (페이지 로드 시 자동 호출)
 * URL: https://chancemobile.co.kr/view/plan/phone_plan.aspx
 * 응답 필드: GDCD, GDNM, GDDESC, MNO_CD, NETDIV, BLOCKYN,
 *            DATAAMOUNT, VOICEAMOUNT, LETTERAMOUNT,
 *            TT_AMT (정가), ORGCHARGE (프로모션가), LIMPERIOD (할인기간),
 *            QOSFG, QOSAMT
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://chancemobile.co.kr/view/plan/phone_plan.aspx';
const AJAX_PATH  = '/common/component/plan/AjaxPhone_plan.aspx';

function parsePrice(str) {
  if (!str && str !== 0) return null;
  const n = parseInt(String(str).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseVoice(v) {
  if (!v) return '기본제공';
  if (/무제한/.test(v)) return '무제한';
  if (v === '0분') return '기본제공';
  return v.trim();
}

function parseSms(v) {
  if (!v) return '기본제공';
  if (/무제한/.test(v)) return '무제한';
  if (v === '0건') return '기본제공';
  return v.trim();
}

function parseData(v) {
  if (!v) return null;
  if (/무제한/.test(v)) return '무제한';
  if (v === '0MB' || v === '0GB') return null;
  return v.trim() || null;
}

function parseQos(qosFg, qosAmt) {
  if (!qosFg || qosFg === '0') return null;
  const text = (qosAmt || '').trim().replace(/^\+\s*/, '').trim();
  const m = text.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  return m ? `${m[1]}${m[2]}` : (text || null);
}

async function crawl(log = console.log) {
  log('  [찬스모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 페이지 로드 중 AjaxPhone_plan.aspx 자동 호출됨 → 인터셉트
  let rawData = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes('AjaxPhone_plan')) return;
    try {
      const json = await resp.json();
      if (Array.isArray(json.DATA) && json.DATA.length > 1) {
        rawData = json.DATA;
      }
    } catch {}
  });

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 인터셉트 실패 시 직접 POST 호출
  if (!rawData) {
    rawData = await page.evaluate(async (ajaxPath) => {
      const r = await fetch(ajaxPath, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ header: [{ type: '' }], body: [{ seq: '', order_type: 'AMT', order_align: 'AS' }] }),
      });
      const json = await r.json();
      return json.DATA || [];
    }, AJAX_PATH);
  }

  await browser.close();
  log(`  [찬스모바일] ${(rawData || []).length}건 수신`);

  if (!rawData || rawData.length === 0) throw new Error('요금제 데이터 없음');

  const allPlans = [];
  const seenCodes = new Set();
  const collectedAt = new Date().toISOString();

  for (const item of rawData) {
    // 판매 중단 / 비노출 제외
    if (item.BLOCKYN === 'Y') continue;

    const basePrice = parsePrice(item.TT_AMT);
    if (!basePrice || basePrice === 0) continue;

    const code = item.GDCD || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = (item.GDNM || '').trim();
    if (!planName) continue;

    // ORGCHARGE = 프로모션 기간 중 월 납부금액, LIMPERIOD = 할인 기간
    const orgCharge  = parsePrice(item.ORGCHARGE);
    const limPeriod  = (item.LIMPERIOD || '').trim();

    let monthlyFee = basePrice;
    let discountPeriod = '-';
    let priceAfterDiscount = null;

    if (limPeriod && orgCharge && orgCharge < basePrice) {
      monthlyFee       = orgCharge;
      discountPeriod   = limPeriod; // 이미 "6개월" 형태
      priceAfterDiscount = basePrice;
    }

    const networkType = (item.NETDIV || '').toUpperCase() === '5G' ? '5G' : 'LTE';

    allPlans.push({
      company:              '찬스모바일',
      carrier:              item.MNO_CD || 'LGU+',
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            planName,
      plan_code:            code,
      voice:                parseVoice(item.VOICEAMOUNT),
      sms:                  parseSms(item.LETTERAMOUNT),
      data:                 parseData(item.DATAAMOUNT),
      qos:                  parseQos(item.QOSFG, item.QOSAMT),
      benefits:             item.GDDESC || '-',
      base_price:           basePrice,
      monthly_fee:          monthlyFee,
      price_after_discount: priceAfterDiscount,
      discount_period:      discountPeriod,
      source_url:           SOURCE_URL,
      collected_at:         collectedAt,
      _operator:            'chance',
    });
  }

  log(`  [찬스모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
