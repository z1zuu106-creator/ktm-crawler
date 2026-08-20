/**
 * 프리티 요금제 크롤러
 * API: GET https://api.freet.co.kr/plan/v1/list
 * 페이지당 20건, 전체 페이지 순회
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const API_BASE = 'https://api.freet.co.kr/plan/v1/list';
const SOURCE_URL = 'https://www.freet.co.kr/plan/ratePlan';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': SOURCE_URL,
  'Accept': 'application/json',
};

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) || n === 0 ? null : n;
}

function parseData(raw) {
  if (!raw) return { raw: null, normalized: null };
  const s = raw.replace(/^월/, '').trim();
  // "100GB", "11GB+매일2GB", "15GB", "무제한" 등
  if (s.includes('무제한')) return { raw, normalized: '무제한' };
  const m = s.match(/^([\d.]+\s*(?:GB|MB|TB))/i);
  if (m) return { raw, normalized: m[1].replace(/\s+/, '') };
  return { raw, normalized: s };
}

function parseVoice(freeVoice, freeVoiceAdd) {
  // freeVoice: "기본제공", "100분", "무제한"
  // freeVoiceAdd: "(부가음성 300분)" 등
  const base = (freeVoice || '기본제공').trim();
  if (!freeVoiceAdd) return base;
  // "(부가음성 300분)" → "기본 + 부가 300분"
  const addM = freeVoiceAdd.match(/(\d+)분/);
  if (addM) {
    if (base === '기본제공') return `기본제공+부가${addM[1]}분`;
    return `${base}+부가${addM[1]}분`;
  }
  return base;
}

async function fetchPage(pageNo) {
  const url = `${API_BASE}?rowSize=20&pageNo=${pageNo}&onlineAuth=Y`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${pageNo}`);
  const json = await res.json();
  if (json.status !== 'success') throw new Error(`API error: ${json.retMsg}`);
  return json.data;
}

async function crawl(log = console.log) {
  log('  [프리티] API 요청 시작...');

  const firstPage = await fetchPage(1);
  const totalCount = firstPage.totalCount || 0;
  const rowSize = 20;
  const totalPages = Math.ceil(totalCount / rowSize);
  log(`  [프리티] 총 ${totalCount}건 / ${totalPages}페이지`);

  const rawPlans = [...(firstPage.ratePlans || [])];

  for (let page = 2; page <= totalPages; page++) {
    const data = await fetchPage(page);
    const plans = data.ratePlans || [];
    rawPlans.push(...plans);
    if (plans.length === 0) break;
  }

  log(`  [프리티] 수집 완료: ${rawPlans.length}건`);

  const collectedAt = new Date().toISOString();
  const seen = new Set();
  const allPlans = [];

  for (const item of rawPlans) {
    const planCode = item.svcCd || '';
    if (seen.has(planCode)) continue;
    seen.add(planCode);

    const planName = (item.svcName || '').trim();
    if (!planName) continue;

    const basicFee   = parsePrice(item.basicFee);
    const monthlyFee = parsePrice(item.monthlyFee);
    // basicFee = 정상가(기본료), monthlyFee = 현재 할인가
    const base_price    = basicFee;
    const benefit_price = (monthlyFee && monthlyFee < basicFee) ? monthlyFee : null;

    const { raw: data_allowance_raw, normalized: data_allowance_normalized } = parseData(item.freeData);
    const voice_allowance = parseVoice(item.freeVoice, item.freeVoiceAdd);
    const sms_allowance   = (item.freeSms || '기본제공').trim();
    const qos_speed       = item.qos ? item.qos.trim() : null;
    const network_type    = (item.genCd || 'LTE').toUpperCase() === '5G' ? '5G' : 'LTE';

    allPlans.push({
      plan_name: planName,
      plan_code: planCode,
      data_allowance_raw,
      data_allowance_normalized,
      qos_raw: qos_speed,
      qos_speed,
      voice_allowance,
      sms_allowance,
      base_price_text:    base_price    ? `월 ${base_price.toLocaleString()}원`    : null,
      base_price,
      benefit_price_text: benefit_price ? `혜택가 월 ${benefit_price.toLocaleString()}원` : null,
      benefit_price,
      plan_type: ['유심'],
      partnership_flag: false,
      network_type,
      product_group: '전체',
      source_url: SOURCE_URL,
      collected_at: collectedAt,
      _operator: 'freet',
    });

    log(`    ✓ [프리티] ${planName} | ${data_allowance_normalized} | QoS:${qos_speed} | 기본:${base_price}원${benefit_price ? ` / 혜택:${benefit_price}원` : ''}`);
  }

  log(`  [프리티] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
