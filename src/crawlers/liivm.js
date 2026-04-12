/**
 * KB Liiv M (리브엠모바일) 요금제 크롤러
 * 방식: API 직접 호출
 * URL: https://m.liivm.com/rateplan/plans/products
 * API: GET https://m.liivm.com/appIf/v1/ratePlan/LMPM000009
 */

const SOURCE_URL = 'https://m.liivm.com/rateplan/plans/products';
const API_URL = 'https://m.liivm.com/appIf/v1/ratePlan/LMPM000009';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': SOURCE_URL,
};

// soId: 01=LGU+, 02=KT, 03=SKT
const TELECOM_MAP = { '01': 'LGU+', '02': 'KT', '03': 'SKT' };
// svcTp: 01=LTE, 02=5G
const NETWORK_MAP = { '01': 'LTE', '02': '5G', '03': 'LTE' };

function parsePrice(val) {
  if (!val && val !== 0) return null;
  const n = parseInt(String(val).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function buildData(item) {
  const unit = item.dataUnit || '';
  if (!unit || unit === '0') return { raw: null, normalized: null };
  return { raw: unit, normalized: unit };
}

function buildQoS(item) {
  const qos = item.qosUnit || item.qosSpeed || '';
  if (!qos) return { qos_speed: null, qos_raw: null };
  const m = String(qos).match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: qos };
  return { qos_speed: null, qos_raw: qos };
}

async function fetchPlans() {
  const res = await fetch(API_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // 응답 구조에 따라 배열 추출
  return Array.isArray(json) ? json
    : json.data || json.list || json.result || json.content || json.ratePlanList || [];
}

async function crawl(log = console.log) {
  log('  [리브엠모바일] 요금제 목록 조회 중...');

  let rawItems;
  try {
    rawItems = await fetchPlans();
    log(`  [리브엠모바일] ${rawItems.length}건 응답`);
  } catch (e) {
    throw new Error(`API 호출 실패: ${e.message}`);
  }

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of rawItems) {
    // 판매 종료 상품 제외
    if (item.mstrFl === '0' || item.prodLvl === '2') continue;
    // 스타뱅킹 전용 제외
    if (item.sbYn === 'Y') continue;

    const code = item.prodCd || item.planCd || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = (item.prodNm || item.planNm || '').trim();
    if (!planName) continue;

    const basePrice = parsePrice(item.prodPrice || item.basePrice);
    const eventAmt = parsePrice(item.eventAmt);
    const benefitPrice = (item.eventYn === 'Y' && eventAmt)
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
      _telecom: TELECOM_MAP[item.soId] || item.soId,
    });
  }

  log(`  [리브엠모바일] 최종 ${allPlans.length}건 (판매종료/스타뱅킹 제외)`);
  return allPlans;
}

module.exports = { crawl };
