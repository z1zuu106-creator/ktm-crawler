/**
 * 티플러스 요금제 크롤러 (중소사업자)
 * API: POST https://www.tplusmobile.com/BackBone/rate/rate_list
 * 응답: HTML (cardArea 구조)
 * 방식: Playwright 브라우저 세션 확보 후 API 호출 → HTML 파싱
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.tplusmobile.com/main/rate/join';
const API_PATH   = '/BackBone/rate/rate_list';

// 요금제 전체 요청 파라미터 (브라우저에서 캡처한 그대로)
const API_BODY = 'tp=F&key=&keyword=&seloptiontp=&selcompanytp=&recommendtp=&selplanstp=all_plans' +
  '&filter_data_s=0&filter_data_e=10001&filter_voice_s=0&filter_voice_e=501' +
  '&filter_price_s=0&filter_price_e=50001&selsorttp=&sel_companies=&sel_sms=' +
  '&sel_network=&sel_qos=&sel_term=&sel_benefit_seqs=';

/**
 * 통신사 뱃지 → 통신사명
 * badge 클래스: "badge kt", "badge lgu", "badge skt" 등
 */
function parseCarrier(badgeEl) {
  if (!badgeEl) return '';
  const cls = badgeEl.className || '';
  if (cls.includes('kt'))  return 'KT';
  if (cls.includes('lgu')) return 'LGU+';
  if (cls.includes('skt') || cls.includes(' s ') || cls.endsWith(' s')) return 'SKT';
  return badgeEl.textContent?.trim() || '';
}

/**
 * 금액 문자열 → 숫자
 * "월 44,000원" → 44000
 * "23,000" → 23000
 */
function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/**
 * 할인기간 추출
 * "7개월 요금할인" → "7개월"
 * "평생 요금할인"  → "평생"
 * "평생 월 1,900 원" (disc16 텍스트) → "평생"
 * "7개월간 월 23,000 원"             → "7개월"
 */
function parseDiscountPeriod(badgeText, disc16Text) {
  // 커스텀 뱃지 우선: "N개월 요금할인" or "평생 요금할인"
  if (badgeText) {
    const m = badgeText.match(/^(\d+)개월/);
    if (m) return `${m[1]}개월`;
    if (badgeText.includes('평생')) return '평생';
  }
  // disc16px700 텍스트: "7개월간 월 ...", "평생 월 ..."
  if (disc16Text) {
    const m2 = disc16Text.match(/^(\d+)개월/);
    if (m2) return `${m2[1]}개월`;
    if (disc16Text.startsWith('평생')) return '평생';
  }
  return '-';
}

/**
 * 데이터/QoS 분리
 * desc20Text: "100GB 최대 5Mbps" or "6GB" or "무제한"
 */
function parseDataQos(desc20Text) {
  if (!desc20Text) return { data: null, qos: null };
  const s = desc20Text.trim().replace(/\s+/g, ' ');
  const qosMatch = s.match(/최대\s+([\d.]+\s*(?:Mbps|Kbps))/i);
  const qos  = qosMatch ? qosMatch[1].trim() : null;
  const data = s.replace(/최대.*$/, '').trim() || null;
  return { data, qos };
}

async function crawl(log = console.log) {
  log('  [티플러스] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 브라우저 세션 확보 (쿠키, CSRF 등)
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);

  // rate_list API 호출 → HTML 응답
  const rawHtml = await page.evaluate(async ({ apiPath, apiBody }) => {
    const r = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: apiBody,
    });
    return r.text();
  }, { apiPath: API_PATH, apiBody: API_BODY });

  // 응답 앞의 상태 접두어 제거: "TRUEㅹㆄ<div..."
  const htmlBody = rawHtml.replace(/^[^<]*/, '');

  // DOM 파싱 및 카드 추출 (브라우저 내 DOMParser 사용)
  const cards = await page.evaluate((html) => {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');
    const cardEls = Array.from(doc.querySelectorAll('.cardArea'));

    return cardEls.map(card => {
      // 통신사 뱃지 (첫 번째 badge = 통신사, 두 번째 = 할인 뱃지)
      const badges = Array.from(card.querySelectorAll('.badge'));
      const carrierBadge = badges.find(b =>
        /\b(kt|lgu|skt|s\b)/.test(b.className.toLowerCase())
      );
      const discountBadge = badges.find(b => b.className.includes('custom'));

      // 요금제명
      const title = card.querySelector('h4')?.textContent?.trim() || '';

      // 데이터 + QoS
      const desc20Text = card.querySelector('.desc20px700')?.textContent?.trim().replace(/\s+/g, ' ') || '';

      // 음성 / 문자
      const icoCall    = card.querySelector('.ico.call')?.textContent?.trim()    || '기본제공';
      const icoMessage = card.querySelector('.ico.message')?.textContent?.trim() || '기본제공';

      // 기본료 (정가)
      const throthDesc = card.querySelector('.throthDesc')?.textContent?.trim() || '';

      // 할인가 (textPoint 첫 번째)
      const textPoints = Array.from(card.querySelectorAll('.textPoint'));
      const discPrice  = textPoints[0]?.textContent?.trim() || '';

      // 할인기간 텍스트 (desc16px700)
      const disc16Text = card.querySelector('.desc16px700')?.textContent?.trim().replace(/\s+/g, ' ') || '';

      // 혜택 텍스트
      const benefitTexts = Array.from(card.querySelectorAll('.benefitArea .text, .iconBenefitArea .text'))
        .map(s => s.textContent.trim())
        .filter(Boolean);

      return {
        carrierClass:  carrierBadge?.className || '',
        carrierText:   carrierBadge?.textContent?.trim() || '',
        discountBadge: discountBadge?.textContent?.trim() || '',
        title,
        desc20Text,
        icoCall,
        icoMessage,
        throthDesc,
        discPrice,
        disc16Text,
        benefitTexts,
      };
    });
  }, htmlBody);

  await browser.close();
  log(`  [티플러스] ${cards.length}건 수신`);

  const allPlans  = [];
  const seenNames = new Set();

  for (const c of cards) {
    if (!c.title) continue;
    if (seenNames.has(c.title)) continue;
    seenNames.add(c.title);

    // 통신사
    let carrier = '';
    const cls = c.carrierClass.toLowerCase();
    if (cls.includes('kt'))  carrier = 'KT';
    else if (cls.includes('lgu')) carrier = 'LGU+';
    else if (cls.includes('skt') || /\bskt\b/.test(cls)) carrier = 'SKT';
    else carrier = c.carrierText;

    // 데이터 / QoS
    const { data, qos } = parseDataQos(c.desc20Text);

    // 가격
    const basePrice    = parsePrice(c.throthDesc);
    const discountedFee = c.discPrice ? parsePrice(c.discPrice) : null;
    const monthlyFee   = discountedFee !== null ? discountedFee : basePrice;

    // 할인기간
    const discountPeriod = parseDiscountPeriod(c.discountBadge, c.disc16Text);

    // 할인 후 금액 (기간 종료 후 납부 금액)
    let priceAfterDiscount = null;
    if (discountPeriod !== '-' && discountPeriod !== '평생') {
      priceAfterDiscount = basePrice;
    }

    // 5G 감지
    const networkType = /(?<!\d)5G(?!B)/i.test(c.title) ? '5G' : 'LTE';

    // 혜택
    const benefits = c.benefitTexts.join(' / ') || '-';

    allPlans.push({
      company:              '티플러스',
      carrier,
      network_type:         networkType,
      plan_type:            '유심',
      plan_name:            c.title,
      plan_code:            '',
      voice:                c.icoCall  || '기본제공',
      sms:                  c.icoMessage || '기본제공',
      data,
      qos,
      benefits,
      base_price:           basePrice,
      monthly_fee:          monthlyFee,
      price_after_discount: priceAfterDiscount,
      discount_period:      discountPeriod,
      source_url:           SOURCE_URL,
      collected_at:         new Date().toISOString(),
      _operator:            'tplus',
    });
  }

  log(`  [티플러스] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
