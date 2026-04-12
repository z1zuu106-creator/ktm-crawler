/**
 * KB Liiv M (리브엠모바일) 요금제 크롤러
 * 방식: Playwright로 페이지 로딩 후 API 응답 인터셉트
 * URL: https://m.liivm.com/rateplan/plans/products
 * API: POST /appIf/v1/ratePlan/LMPM000009 (세션 필요)
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://m.liivm.com/rateplan/plans/products';

// svcTp: 01=LTE, 02=5G, 03=태블릿
const NETWORK_MAP = { '01': 'LTE', '02': '5G', '03': 'LTE' };

function parsePrice(val) {
  if (!val && val !== 0) return null;
  const n = parseInt(String(val).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function buildData(item) {
  const unit = (item.dataUnit || '').trim();
  if (!unit || unit === '0') return { raw: null, normalized: null };
  return { raw: unit, normalized: unit };
}

function buildQoS(item) {
  // dataUnit에 QoS 포함 여부 확인 (예: "월25GB+5Mbps")
  const unit = item.dataUnit || '';
  const m = unit.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: unit };
  return { qos_speed: null, qos_raw: null };
}

async function crawl(log = console.log) {
  log('  [리브엠모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let rawItems = [];

  // API 응답 캡처
  page.on('response', async (response) => {
    if (!response.url().includes('ratePlan/LMPM000009')) return;
    try {
      const json = await response.json();
      const list = json.searchProdList || json.data?.list || [];
      if (Array.isArray(list) && list.length > 0) {
        rawItems.push(...list);
      }
    } catch {}
  });

  try {
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    log(`  [리브엠모바일] 페이지 로딩 오류: ${e.message}`);
  }

  await browser.close();

  log(`  [리브엠모바일] ${rawItems.length}건 응답`);

  if (rawItems.length === 0) {
    throw new Error('요금제 데이터 없음 - API 응답 캡처 실패');
  }

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of rawItems) {
    // 판매 종료 / 미노출 제외
    if (item.prodLvl === '2') continue;
    // 스타뱅킹 전용 제외
    if (item.sbYn === 'Y') continue;

    const code = item.prodCd || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = (item.prodNm || '').trim();
    if (!planName) continue;

    const basePrice = parsePrice(item.prodPrice);
    const eventAmt = parsePrice(item.eventAmt);
    // eventAmt는 할인금액 → 혜택가 = basePrice - eventAmt
    const benefitPrice = (item.eventYn === 'Y' && eventAmt && eventAmt > 0 && basePrice)
      ? basePrice - eventAmt
      : null;
    const isBenefitDiff = benefitPrice !== null && benefitPrice !== basePrice && benefitPrice > 0;

    const { raw: data_allowance_raw, normalized: data_allowance_normalized } = buildData(item);
    const { qos_speed, qos_raw } = buildQoS(item);
    const network = NETWORK_MAP[item.svcTp] || (planName.includes('5G') ? '5G' : 'LTE');

    allPlans.push({
      plan_name: planName,
      plan_code: code,
      data_allowance_raw,
      data_allowance_normalized,
      qos_raw,
      qos_speed,
      voice_allowance: item.voiceUnit || '기본제공',
      sms_allowance: item.smsUnit || '기본제공',
      base_price_text: basePrice ? `월 ${basePrice.toLocaleString()}원` : null,
      base_price: basePrice,
      benefit_price_text: isBenefitDiff ? `혜택가 월 ${benefitPrice.toLocaleString()}원` : null,
      benefit_price: isBenefitDiff ? benefitPrice : null,
      plan_type: ['유심'],
      partnership_flag: false,
      network_type: network,
      product_group: item.prodGrpCd || '전체',
      source_url: SOURCE_URL,
      collected_at: new Date().toISOString(),
      _operator: 'liivm',
    });
  }

  log(`  [리브엠모바일] 최종 ${allPlans.length}건 (판매종료/스타뱅킹 제외)`);
  return allPlans;
}

module.exports = { crawl };
