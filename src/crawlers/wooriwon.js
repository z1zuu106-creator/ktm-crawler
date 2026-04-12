/**
 * 우리WON모바일 요금제 크롤러
 * 방식: Playwright로 CSR 렌더링 후 API 응답 인터셉트
 * URL: https://www.wooriwonmobile.com/rate-plan/list
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.wooriwonmobile.com/rate-plan/list';

function parsePrice(val) {
  if (!val && val !== 0) return null;
  const n = parseInt(String(val).replace(/[,\s원]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseData(str) {
  if (!str) return { raw: null, normalized: null };
  const s = String(str).trim();
  if (!s || s === '0') return { raw: null, normalized: null };
  return { raw: s, normalized: s };
}

function parseQoS(str) {
  if (!str) return { qos_speed: null, qos_raw: null };
  const m = String(str).match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: str };
  return { qos_speed: null, qos_raw: null };
}

async function crawl(log = console.log) {
  log('  [우리WON모바일] 페이지 로딩 중...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // API 응답 캡처
  const capturedPlans = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('rate') && !url.includes('plan') && !url.includes('product')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json();
      // 배열이거나 list/data 키를 가진 경우
      const list = Array.isArray(json) ? json
        : json.data || json.list || json.result || json.content || [];
      if (Array.isArray(list) && list.length > 0) {
        capturedPlans.push(...list);
      }
    } catch {}
  });

  try {
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    log(`  [우리WON모바일] 페이지 로딩 오류: ${e.message}`);
  }

  let allPlans = [];

  // API로 캡처된 데이터 사용
  if (capturedPlans.length > 0) {
    log(`  [우리WON모바일] API 응답 ${capturedPlans.length}건 캡처`);
    const seenCodes = new Set();
    for (const item of capturedPlans) {
      const code = item.planCd || item.planCode || item.prodCd || item.id || JSON.stringify(item).slice(0, 50);
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);

      const planName = item.planNm || item.planName || item.prodNm || item.name || '';
      if (!planName) continue;

      const basePrice = parsePrice(item.price || item.basePrice || item.planPrice || item.monthFee);
      const benefitPrice = parsePrice(item.discountPrice || item.eventPrice || item.salePrice);
      const isBenefitDiff = benefitPrice !== null && benefitPrice !== basePrice;

      const dataStr = item.data || item.dataAmt || item.dataVolume || item.dataGb || '';
      const { raw: data_allowance_raw, normalized: data_allowance_normalized } = parseData(dataStr);
      const qosStr = item.qos || item.throttleSpeed || item.qosSpeed || '';
      const { qos_speed, qos_raw } = parseQoS(qosStr);
      const voice = item.voice || item.call || item.voiceAmt || '기본제공';
      const sms = item.sms || item.message || item.smsAmt || '기본제공';
      const network = String(item.network || item.networkType || item.type || '').includes('5G') ? '5G' : 'LTE';

      allPlans.push({
        plan_name: planName,
        plan_code: code,
        data_allowance_raw,
        data_allowance_normalized,
        qos_raw,
        qos_speed,
        voice_allowance: String(voice),
        sms_allowance: String(sms),
        base_price_text: basePrice ? `월 ${basePrice.toLocaleString()}원` : null,
        base_price: basePrice,
        benefit_price_text: isBenefitDiff ? `혜택가 월 ${benefitPrice.toLocaleString()}원` : null,
        benefit_price: isBenefitDiff ? benefitPrice : null,
        plan_type: ['유심'],
        partnership_flag: false,
        network_type: network,
        product_group: '전체',
        source_url: SOURCE_URL,
        collected_at: new Date().toISOString(),
        _operator: 'wooriwon',
      });
    }
  } else {
    // DOM 파싱 폴백
    log('  [우리WON모바일] API 미캡처, DOM 파싱 시도...');
    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="plan"], [class*="rate"], [class*="product"], [class*="card"]');
      return Array.from(cards).map(card => ({
        text: card.innerText || card.textContent || '',
        html: card.innerHTML.substring(0, 500),
      })).filter(c => c.text.includes('원') && c.text.length > 20);
    });

    const seenNames = new Set();
    for (const item of items) {
      const lines = item.text.split('\n').map(l => l.trim()).filter(Boolean);
      const planName = lines[0];
      if (!planName || seenNames.has(planName)) continue;
      seenNames.add(planName);

      const priceMatch = item.text.match(/(\d{1,3}(?:,\d{3})*)\s*원/);
      const basePrice = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;
      const dataMatch = item.text.match(/(\d+(?:\.\d+)?)\s*GB/i);
      const dataStr = dataMatch ? `${dataMatch[1]}GB` : null;
      const qosMatch = item.text.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
      const qos_speed = qosMatch ? `${qosMatch[1]}${qosMatch[2]}` : null;

      allPlans.push({
        plan_name: planName,
        plan_code: '',
        data_allowance_raw: dataStr,
        data_allowance_normalized: dataStr,
        qos_raw: qos_speed,
        qos_speed,
        voice_allowance: '기본제공',
        sms_allowance: '기본제공',
        base_price_text: basePrice ? `월 ${basePrice.toLocaleString()}원` : null,
        base_price: basePrice,
        benefit_price_text: null,
        benefit_price: null,
        plan_type: ['유심'],
        partnership_flag: false,
        network_type: item.text.includes('5G') ? '5G' : 'LTE',
        product_group: '전체',
        source_url: SOURCE_URL,
        collected_at: new Date().toISOString(),
        _operator: 'wooriwon',
      });
    }
  }

  await browser.close();
  log(`  [우리WON모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
