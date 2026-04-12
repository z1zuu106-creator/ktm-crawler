/**
 * U+ 알뜰모바일 요금제 크롤러
 * 방식: Playwright로 페이지 렌더링 후 HTML data-* 속성 파싱
 * URL: https://www.uplusumobile.com/product/pric/usim/pricList
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.uplusumobile.com/product/pric/usim/pricList';

// ppngen: 4=LTE, 5=5G (추정치; 텍스트로도 보정)
const GEN_MAP = { '4': 'LTE', '5': '5G', '3': '5G' };

function parsePrice(val) {
  if (!val) return null;
  const n = parseInt(String(val).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function buildQoS(qosVolKbps, cardText) {
  const kbps = parseInt(qosVolKbps, 10);
  if (kbps > 0) {
    let speed;
    if (kbps >= 1000 && kbps % 1000 === 0) speed = `${kbps / 1000}Mbps`;
    else if (kbps >= 1024 && kbps % 1024 === 0) speed = `${kbps / 1024}Mbps`;
    else if (kbps >= 1000) speed = `${(kbps / 1000).toFixed(1)}Mbps`;
    else speed = `${kbps}Kbps`;
    return { qos_speed: speed, qos_raw: cardText || null };
  }
  // 텍스트에서 재시도
  if (cardText) {
    const m = cardText.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
    if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: cardText };
  }
  return { qos_speed: null, qos_raw: null };
}

function buildDataAllowance(ofrdataval, cardText) {
  // cardText 예: "7GB+1Mbps", "(7+10)GB+1Mbps", "무제한"
  if (!cardText) {
    const gb = parseFloat(ofrdataval);
    return gb > 0 ? { raw: `${gb}GB`, normalized: `${gb}GB` } : { raw: null, normalized: null };
  }

  // QoS 부분 제거한 데이터 부분만 추출
  const dataOnly = cardText
    .replace(/\+?\s*(?:최대\s*)?\d+(?:\.\d+)?\s*(?:Mbps|Kbps)/gi, '')
    .trim()
    .replace(/\+$/, '')
    .trim();

  return { raw: cardText, normalized: dataOnly || cardText };
}

function determineNetwork(ppngen, planName) {
  if (GEN_MAP[ppngen]) return GEN_MAP[ppngen];
  if (planName?.includes('5G')) return '5G';
  return 'LTE';
}

async function crawl(log = console.log) {
  log('  [유모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const rawItems = await page.evaluate(() => {
    const items = document.querySelectorAll('#bx-list > div');
    return Array.from(items).map(item => {
      const ds = item.dataset;

      // 데이터 표시 텍스트 찾기 (보통 두 번째 줄)
      const allText = item.innerText || item.textContent || '';
      const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

      // 데이터 라인: 첫 번째 줄(플랜명) 제외하고 탐색
      // "7GB+1Mbps", "(7+10)GB+1Mbps", "무제한" 같은 패턴
      // 플랜명이 아닌 순수 데이터 표기: Mbps 포함되거나 숫자+GB로만 구성
      const dataLine = lines.slice(1).find(l =>
        (l.match(/GB|MB|무제한/) && l.match(/\d/)) &&
        (l.match(/Mbps|Kbps/) || l.match(/^[\d().+\s]+(?:GB|MB)/))
      );

      // 통화/문자 라인
      const voiceLine = lines.find(l => l.includes('통화') && !l.includes('데이터'));
      const smsLine = lines.find(l => l.includes('문자') && !l.includes('데이터'));

      return {
        ppnnm: ds.ppnnm,
        bscchrgaddvat: ds.bscchrgaddvat,
        discntaddvat: ds.discntaddvat,
        ofrdataval: ds.ofrdataval,
        ppngen: ds.ppngen,
        offervoice: ds.offervoice,
        qosofrvol: ds.qosofrvol,
        sgntrseq: ds.sgntrseq,
        excluseq: ds.excluseq,
        dataLine,
        voiceLine,
        smsLine,
        fullText: allText.substring(0, 300),
      };
    });
  });

  await browser.close();

  log(`  [유모바일] ${rawItems.length}건 추출`);

  const allPlans = [];
  const seenNames = new Set();

  for (const item of rawItems) {
    const planName = item.ppnnm?.trim() || '';
    if (!planName) continue;
    if (seenNames.has(planName)) continue;
    seenNames.add(planName);

    const network = determineNetwork(item.ppngen, planName);
    const { raw: data_allowance_raw, normalized: data_allowance_normalized } =
      buildDataAllowance(item.ofrdataval, item.dataLine);
    const { qos_speed, qos_raw } = buildQoS(item.qosofrvol, item.dataLine);

    const basePrice = parsePrice(item.bscchrgaddvat);
    const benefitPrice = parsePrice(item.discntaddvat);
    const isBenefitDiff = benefitPrice !== null && benefitPrice !== basePrice;

    // 음성
    let voice_allowance = item.offervoice?.trim() || null;
    if (!voice_allowance && item.voiceLine) {
      voice_allowance = item.voiceLine.replace(/통화\s*/, '').trim() || '기본제공';
    }
    if (!voice_allowance) voice_allowance = '기본제공';

    // 문자
    let sms_allowance = null;
    if (item.smsLine) {
      sms_allowance = item.smsLine.replace(/문자\s*/, '').trim() || '기본제공';
    }
    if (!sms_allowance) sms_allowance = '기본제공';

    allPlans.push({
      plan_name: planName,
      plan_code: '',   // U+는 코드 미제공
      data_allowance_raw,
      data_allowance_normalized,
      qos_raw,
      qos_speed,
      voice_allowance,
      sms_allowance,
      base_price_text: basePrice ? `월 ${basePrice.toLocaleString()}원` : null,
      base_price: basePrice,
      benefit_price_text: isBenefitDiff ? `혜택가 월 ${benefitPrice.toLocaleString()}원` : null,
      benefit_price: isBenefitDiff ? benefitPrice : null,
      plan_type: ['유심'],
      partnership_flag: item.sgntrseq && item.sgntrseq !== '0',
      network_type: network,
      product_group: '전체',
      source_url: SOURCE_URL,
      collected_at: new Date().toISOString(),
      _operator: 'uplus',
    });
  }

  log(`  [유모바일] 최종 ${allPlans.length}건 (중복 제거 후)`);
  return allPlans;
}

module.exports = { crawl };
