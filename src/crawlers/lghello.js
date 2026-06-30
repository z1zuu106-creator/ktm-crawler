/**
 * 헬로모바일 요금제 크롤러
 * API: POST /fund/ajaxRateList.do
 * 통신망: LGU, KT 모두 수집 / 유심+휴대폰 모두 수집
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://direct.lghellovision.net';
const SOURCE_URL_USIM = 'https://direct.lghellovision.net/rate/rateViewUsim.do';
const SOURCE_URL_PHONE = 'https://direct.lghellovision.net/rate/rateViewPhone.do';
const SOURCE_URL = SOURCE_URL_USIM;

const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': SOURCE_URL,
  'X-Requested-With': 'XMLHttpRequest',
};

// dedicatedCallsGubun: 'L'=무제한, 'B'=기본제공(분수)
// dedicatedDataDepletionRate: 숫자(Mbps), 0=없음
const CALL_GUBUN = { L: '무제한', B: null };
const SMS_GUBUN = { L: '무제한', B: null };

async function fetchPlanList(telecom, rateType = 'U') {
  const body = new URLSearchParams({
    reqRateType: rateType,  // U=유심, P=휴대폰
    reqTelecom: telecom,
    reqOrder: 'S1',
    reqUsimType: '',
    reqDataSum: '',
    reqDepleRateList: '',
    reqCalls: '',
    reqPriceGubunList: '',
    reqMin: '0',
    reqMax: '700000',
    reqText: '',
  }).toString();

  const res = await fetch(`${BASE_URL}/fund/ajaxRateList.do`, {
    method: 'POST',
    headers: HEADERS,
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.list || [];
}

function buildDataAllowance(item) {
  const monthly = parseFloat(item.dedicatedMonthlyOfferValue) || 0;
  const daily = parseFloat(item.dedicatedDailyOfferValue) || 0;

  if (monthly === 0 && daily === 0) return { raw: null, normalized: null };
  if (daily > 0 && monthly > 0) {
    return {
      raw: `${monthly}GB+일${daily}GB`,
      normalized: `${monthly}GB+일${daily}GB`,
    };
  }
  if (daily > 0) {
    return { raw: `일${daily}GB`, normalized: `일${daily}GB` };
  }
  return { raw: `${monthly}GB`, normalized: `${monthly}GB` };
}

function buildQoS(depletionRate, dataRaw) {
  const rate = parseInt(depletionRate, 10);
  if (!rate || rate === 0) return { qos_speed: null, qos_raw: null };
  return {
    qos_speed: `${rate}Mbps`,
    qos_raw: dataRaw ? `${dataRaw}+${rate}Mbps` : `${rate}Mbps`,
  };
}

function buildVoice(item) {
  if (item.dedicatedCallsGubun === 'L') return '무제한';
  const val = item.dedicatedCallsValue;
  if (val && parseInt(val) > 0) return `${val}분`;
  return '기본제공';
}

function buildSMS(item) {
  if (item.dedicatedSmsGubun === 'L') return '무제한';
  const val = item.dedicatedSmsValue;
  if (val && parseInt(val) > 0) return `${val}건`;
  return '기본제공';
}

function parsePlan(item, telecom, rateType) {
  const { raw: data_allowance_raw, normalized: data_allowance_normalized } = buildDataAllowance(item);
  const { qos_speed, qos_raw } = buildQoS(item.dedicatedDataDepletionRate, data_allowance_normalized);

  const price = parseInt(item.directPromotionDirectmallPrice, 10) || null;

  return {
    plan_name: item.salesName?.trim() || '',
    plan_code: item.paymentcode || item.idx || '',
    data_allowance_raw,
    data_allowance_normalized,
    qos_raw,
    qos_speed,
    voice_allowance: buildVoice(item),
    sms_allowance: buildSMS(item),
    base_price_text: price ? `월 ${price.toLocaleString()}원` : null,
    base_price: price,
    benefit_price_text: null,
    benefit_price: null,
    plan_type: [rateType === 'P' ? '휴대폰' : '유심'],
    partnership_flag: false,
    network_type: item.usimType === '5G' ? '5G' : 'LTE',
    product_group: item.title?.trim() || '전체',
    source_url: rateType === 'P' ? SOURCE_URL_PHONE : SOURCE_URL_USIM,
    collected_at: new Date().toISOString(),
    _operator: 'lghello',
    _telecom_network: telecom,
  };
}

async function crawl(log = console.log) {
  const allPlans = [];
  const seenCodes = new Set();

  for (const rateType of ['U', 'P']) {
    const typeLabel = rateType === 'U' ? '유심' : '휴대폰';
    for (const telecom of ['LGU', 'KT']) {
      log(`  [헬로모바일] ${typeLabel} ${telecom}망 조회 중...`);
      const items = await fetchPlanList(telecom, rateType);
      let added = 0, duped = 0;

      for (const item of items) {
        const code = item.paymentcode || item.idx;
        if (seenCodes.has(code)) { duped++; continue; }
        seenCodes.add(code);
        allPlans.push(parsePlan(item, telecom, rateType));
        added++;
      }
      log(`    ✓ ${added}건 추가 (중복 ${duped}건), 응답 ${items.length}건`);
    }
  }

  return allPlans;
}

module.exports = { crawl };
