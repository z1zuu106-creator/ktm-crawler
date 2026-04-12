/**
 * 우리WON모바일 요금제 크롤러
 * 방식: API 직접 호출 (POST /appIf/v1/internal/eai/LMPM000012)
 * URL: https://www.wooriwonmobile.com/rate-plan/list
 */

const SOURCE_URL = 'https://www.wooriwonmobile.com/rate-plan/list';
const API_URL = 'https://www.wooriwonmobile.com/appIf/v1/internal/eai/LMPM000012';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': SOURCE_URL,
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://www.wooriwonmobile.com',
};

function makePayload(pageNo, countPerPage = 100) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').substring(0, 19);
  return {
    messageId: Date.now(),
    systemId: 'S00001',
    apiKey: '1234567890',
    serviceId: 'LMPM000012',
    timestamp: ts,
    data: {
      soId: '01',
      pageNo,
      countPerPage,
      prodCtgr: '',
      dataQosList: [],
      chrgAmtFrom: '0',
      chrgAmtTo: '999999',
      dataAmtFrom: '0',
      dataAmtTo: '999999',
      sortTyp: '',
      svcTp: '',
      grpTp: '',
    },
  };
}

function parsePrice(val) {
  if (!val && val !== 0) return null;
  const n = parseInt(String(val).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function buildData(item) {
  // dataDesc: "125GB+5Mbps" / "500MB" 같은 형태
  // dataUnit: "500MB" / "125GB" (데이터만)
  const desc = (item.dataDesc || '').trim();
  const unit = (item.dataUnit || '').trim();
  if (!unit || unit === '0') return { raw: null, normalized: null };
  return { raw: desc || unit, normalized: unit };
}

function buildQoS(item) {
  // dataDesc에서 Mbps/Kbps 추출
  const desc = item.dataDesc || '';
  const m = desc.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: desc };
  return { qos_speed: null, qos_raw: null };
}

function determineNetwork(item) {
  // svcTp: "01"=LTE, "02" or "05"=5G 추정, 또는 prodNm으로 판단
  if (item.svcTp === '02' || item.svcTp === '05') return '5G';
  if ((item.prodNm || '').includes('5G')) return '5G';
  return 'LTE';
}

async function fetchPage(pageNo) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(makePayload(pageNo, 100)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const dsHdr = json.data?.dsHdr || {};
  const dsRes = json.data?.dsRes || [];
  return { totalCnt: dsHdr.totalCnt || 0, items: dsRes };
}

async function crawl(log = console.log) {
  log('  [우리WON모바일] 요금제 목록 조회 중...');

  let allItems = [];
  try {
    const { totalCnt, items } = await fetchPage(1);
    allItems = items;
    log(`  [우리WON모바일] 총 ${totalCnt}건 중 ${items.length}건 수신`);
    // countPerPage=100 이므로 한 번에 다 받아지지만 혹시 초과시 추가 페이지 처리
    if (totalCnt > allItems.length) {
      let page = 2;
      while (allItems.length < totalCnt) {
        const more = await fetchPage(page++);
        if (more.items.length === 0) break;
        allItems.push(...more.items);
      }
    }
  } catch (e) {
    throw new Error(`API 호출 실패: ${e.message}`);
  }

  const allPlans = [];
  const seenCodes = new Set();

  for (const item of allItems) {
    const code = item.prodCd || '';
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);

    const planName = (item.prodNm || '').trim();
    if (!planName) continue;

    const basePrice = parsePrice(item.prodPrice);
    const eventAmt = parsePrice(item.eventAmt);
    // eventAmt는 할인금액 → 혜택가 = basePrice - eventAmt
    const benefitPrice = (eventAmt && eventAmt > 0 && basePrice)
      ? basePrice - eventAmt
      : null;
    const isBenefitDiff = benefitPrice !== null && benefitPrice !== basePrice && benefitPrice > 0;

    const { raw: data_allowance_raw, normalized: data_allowance_normalized } = buildData(item);
    const { qos_speed, qos_raw } = buildQoS(item);
    const network = determineNetwork(item);

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
      product_group: item.grpTp || '전체',
      source_url: SOURCE_URL,
      collected_at: new Date().toISOString(),
      _operator: 'wooriwon',
    });
  }

  log(`  [우리WON모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
