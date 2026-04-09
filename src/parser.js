/**
 * 요금제 데이터 파싱 모듈
 * - 필드 정규화
 * - QoS 추출 로직 (xmlQosCnt 우선, bnfitData 문자열 파싱 보조)
 */

/**
 * QoS 속도 추출
 * 우선순위:
 *  1) xmlQosCnt (kbps 정수값)
 *  2) bnfitData 문자열 정규식 파싱
 *  3) null
 *
 * @param {number} xmlQosCnt kbps 값 (0이면 없음 또는 누락)
 * @param {string} bnfitData 데이터 설명 문자열
 * @returns {{ qos_speed: string|null, qos_raw: string|null }}
 */
function extractQoS(xmlQosCnt, bnfitData) {
  const raw = bnfitData || '';

  // 1) xmlQosCnt > 0: kbps → Mbps 변환
  if (xmlQosCnt && xmlQosCnt > 0) {
    const speedStr = kbpsToStr(xmlQosCnt);
    return { qos_speed: speedStr, qos_raw: raw };
  }

  // 2) bnfitData 문자열 파싱 (xmlQosCnt=0이어도 문자열에 속도 있을 수 있음)
  const parsed = parseQoSFromString(raw);
  if (parsed) {
    return { qos_speed: parsed, qos_raw: raw };
  }

  return { qos_speed: null, qos_raw: null };
}

/**
 * kbps → 읽기 좋은 단위 문자열 변환
 * 예: 1024 → "1Mbps", 512 → "512Kbps", 5120 → "5Mbps"
 */
function kbpsToStr(kbps) {
  if (kbps >= 1000 && kbps % 1000 === 0) {
    return `${kbps / 1000}Mbps`;
  }
  if (kbps >= 1024 && kbps % 1024 === 0) {
    return `${kbps / 1024}Mbps`;
  }
  if (kbps >= 1000) {
    // 소수점 처리 (예: 1500 → 1.5Mbps)
    const mbps = kbps / 1000;
    return `${mbps % 1 === 0 ? mbps : mbps.toFixed(1)}Mbps`;
  }
  return `${kbps}Kbps`;
}

/**
 * 문자열에서 QoS 속도 정규식 파싱
 * 처리 케이스:
 *  - "7GB+최대1Mbps"       → "1Mbps"
 *  - "100GB+1Mbps"          → "1Mbps"
 *  - "무제한 (5Mbps)"      → "5Mbps"
 *  - "매일 2GB 이후 3Mbps" → "3Mbps"
 *  - "3Mbps"                → "3Mbps"
 *  - "1024Kbps"             → "1024Kbps"
 */
function parseQoSFromString(str) {
  if (!str) return null;

  // Mbps 패턴 (최대/이후 등 접두어 제거하고 숫자+단위만 추출)
  const mbpsMatch = str.match(/(\d+(?:\.\d+)?)\s*Mbps/i);
  if (mbpsMatch) return `${mbpsMatch[1]}Mbps`;

  // Kbps 패턴
  const kbpsMatch = str.match(/(\d+(?:\.\d+)?)\s*Kbps/i);
  if (kbpsMatch) return `${kbpsMatch[1]}Kbps`;

  return null;
}

/**
 * 데이터 제공량 정규화
 * @param {string} raw bnfitData 원문 ("7GB+최대1Mbps", "무제한", "일 2GB")
 * @returns {{ data_allowance_raw: string, data_allowance_normalized: string }}
 */
function normalizeData(raw) {
  if (!raw) return { data_allowance_raw: null, data_allowance_normalized: null };

  // QoS 부분 제거 후 데이터만 추출
  // "7GB+최대1Mbps" → "7GB"
  // "무제한 (5Mbps)" → "무제한"
  // "일 2GB+3Mbps" → "일 2GB"
  let normalized = raw
    .replace(/\s*\(.*?Mbps\)/gi, '')  // 괄호 안 속도 제거
    .replace(/\+?\s*(?:최대\s*)?\d+(?:\.\d+)?\s*(?:Mbps|Kbps)/gi, '')  // +속도 제거
    .trim();

  return { data_allowance_raw: raw, data_allowance_normalized: normalized };
}

/**
 * 가격 문자열 정규화
 * @param {string} text "35,200" 또는 null
 * @returns {number|null}
 */
function parsePrice(text) {
  if (!text) return null;
  const num = parseInt(text.replace(/[,\s]/g, ''), 10);
  return isNaN(num) ? null : num;
}

/**
 * 음성 제공량 정규화
 * xmlCallCnt: 999999999 = 무제한
 */
function normalizeVoice(bnfitVoice, xmlCallCnt) {
  if (xmlCallCnt >= 999999999) return '무제한';
  if (bnfitVoice) return bnfitVoice.trim();
  return null;
}

/**
 * 분류 정보 결정
 * @param {Object} category 카테고리 정보
 * @param {Object} categoryMap 전체 카테고리 맵 (cd → category)
 * @param {Object} rawPlan 원본 요금제 데이터
 * @returns {{ plan_type, network_type, partnership_flag, product_group }}
 */
function classifyPlan(category, categoryMap, rawPlan) {
  // 카테고리 조상 체인 구성 (depth-3 → depth-2 → depth-1)
  const chain = buildChain(category, categoryMap);

  const depth1 = chain.find(c => c.depthKey === 1);
  const depth2 = chain.find(c => c.depthKey === 2);

  // 네트워크 타입 (depth-2 카테고리명 기반)
  let network_type = 'LTE';
  if (depth2) {
    const d2name = depth2.rateAdsvcCtgNm || '';
    if (d2name.includes('5G')) network_type = '5G';
    else if (d2name.includes('LTE')) network_type = 'LTE';
    else if (d2name.includes('3G')) network_type = '3G';
    else {
      // depth2가 제휴인 경우: 요금제명으로 판단
      const planName = rawPlan.rateAdsvcNm || '';
      network_type = planName.includes('5G') ? '5G' : 'LTE';
    }
  }

  // 제휴 여부 (depth-1이 제휴이거나, 카테고리 체인에 제휴 포함)
  const partnership_flag = chain.some(c => c.rateAdsvcCtgNm?.includes('제휴'));

  // 가입 형태
  let plan_type = [];
  const planName = rawPlan.rateAdsvcNm || '';
  const addDiv = rawPlan.addDivCd || '';
  const catName = category.rateAdsvcCtgNm || '';

  // eSIM 판단: addDivCd, 요금제명, 카테고리명 중 하나라도 해당되면
  const isESIM = addDiv === 'E'
    || planName.toLowerCase().includes('esim')
    || planName.includes('eSIM')
    || catName.includes('e 요금제')
    || planName.match(/^e\s+5?G/i);  // "e 5G 통화 150분" 같은 패턴

  if (depth1) {
    const d1name = depth1.rateAdsvcCtgNm || '';
    if (d1name.includes('유심') || d1name.includes('eSIM')) {
      plan_type.push(isESIM ? 'eSIM' : '유심');
    } else if (d1name.includes('휴대폰')) {
      plan_type.push('휴대폰');
    } else if (d1name.includes('제휴')) {
      // 제휴는 유심/eSIM 기반
      plan_type.push(isESIM ? 'eSIM' : '유심');
    }
  }

  if (plan_type.length === 0) plan_type.push('유심');

  // 상위 그룹: 가장 하위 depth 카테고리명
  const lowestCat = chain[0]; // chain[0]은 현재 카테고리
  const product_group = lowestCat?.rateAdsvcCtgNm || '전체';

  return { plan_type, network_type, partnership_flag, product_group };
}

/**
 * 카테고리 조상 체인 구성 (현재 → 부모 → 조부모)
 */
function buildChain(category, categoryMap) {
  const chain = [category];
  let current = category;
  let limit = 5;
  while (current.upRateAdsvcCtgCd && limit-- > 0) {
    const parent = categoryMap[current.upRateAdsvcCtgCd];
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * 원본 요금제 데이터를 정규화된 형식으로 변환
 */
function parsePlan(rawPlan, category, categoryMap) {
  const {
    rateAdsvcCd,
    rateAdsvcNm,
    bnfitData,
    bnfitVoice,
    bnfitSms,
    mmBasAmtDesc,
    mmBasAmtVatDesc,
    promotionAmtDesc,
    promotionAmtVatDesc,
    xmlDataCnt,
    xmlQosCnt,
    xmlCallCnt,
  } = rawPlan;

  // QoS 추출
  const { qos_speed, qos_raw } = extractQoS(xmlQosCnt, bnfitData);

  // 데이터 정규화
  const { data_allowance_raw, data_allowance_normalized } = normalizeData(bnfitData);

  // 가격 정규화 (VAT 포함 가격 우선 사용)
  const basePriceText = mmBasAmtVatDesc ? `월 ${mmBasAmtVatDesc}원` : (mmBasAmtDesc ? `월 ${mmBasAmtDesc}원` : null);
  const basePrice = parsePrice(mmBasAmtVatDesc || mmBasAmtDesc);

  const benefitPriceText = promotionAmtVatDesc ? `혜택가 월 ${promotionAmtVatDesc}원` : (promotionAmtDesc ? `혜택가 월 ${promotionAmtDesc}원` : null);
  const benefitPrice = parsePrice(promotionAmtVatDesc || promotionAmtDesc);

  // 분류 정보
  const { plan_type, network_type, partnership_flag, product_group } = classifyPlan(category, categoryMap, rawPlan);

  return {
    plan_name: rateAdsvcNm?.trim() || '',
    plan_code: rateAdsvcCd || '',
    data_allowance_raw,
    data_allowance_normalized,
    qos_raw,
    qos_speed,
    voice_allowance: normalizeVoice(bnfitVoice, xmlCallCnt),
    sms_allowance: bnfitSms?.trim() || null,
    base_price_text: basePriceText,
    base_price: basePrice,
    benefit_price_text: benefitPrice !== null ? benefitPriceText : null,
    benefit_price: benefitPrice,
    plan_type,
    partnership_flag,
    network_type,
    product_group,
    source_url: 'https://www.ktmmobile.com/rate/rateList.do',
    collected_at: new Date().toISOString(),
    // 내부 참조용 (출력 시 제거 가능)
    _category_cd: category.rateAdsvcCtgCd,
    _raw_xml_data_cnt: xmlDataCnt,
    _raw_xml_qos_cnt: xmlQosCnt,
  };
}

module.exports = { parsePlan, extractQoS, parseQoSFromString, kbpsToStr };
