/**
 * 슈가모바일 요금제 크롤러 (중소사업자)
 * 방식: Playwright DOM 파싱 (li.card_list_item 셀렉터)
 * URL: https://www.sugarmobile.co.kr/rate_plan.do?type=T005|T006|T014
 * T005=5G, T006=LTE, T014=LTE(슈가딜)
 */

const { chromium } = require('playwright');

const BASE_URL  = 'https://www.sugarmobile.co.kr';
const SOURCE_URL = `${BASE_URL}/rate_plan.do`;

const PLAN_TYPES = [
  { type: 'T005', network: '5G'  },
  { type: 'T006', network: 'LTE' },
  { type: 'T014', network: 'LTE' },
];

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseData(descFirst) {
  if (!descFirst) return null;
  // "월 데이터 7 GB  + 1Mbps" → "7GB"
  const m = descFirst.match(/([\d.]+)\s*(GB|MB)/i);
  if (m) return `${m[1]}${m[2].toUpperCase()}`;
  if (/무제한/.test(descFirst)) return '무제한';
  return null;
}

function parseQos(descFirst) {
  if (!descFirst) return null;
  const m = descFirst.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  return m ? `${m[1]}${m[2]}` : null;
}

function parseVoice(descSecond) {
  if (!descSecond) return '기본제공';
  const cleaned = descSecond.replace(/^음성통화\s*/i, '').trim();
  if (!cleaned || cleaned === '기본제공') return '기본제공';
  return cleaned;
}

function parseSms(descThird) {
  if (!descThird) return '기본제공';
  const cleaned = descThird.replace(/^문자\s*/i, '').trim();
  if (!cleaned || cleaned === '기본제공') return '기본제공';
  return cleaned;
}

async function collectFromType(page, type, network) {
  await page.goto(`${SOURCE_URL}?type=${type}`, { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1000);

  return page.evaluate(({ network }) =>
    Array.from(document.querySelectorAll('li.card_list_item')).map(card => {
      const link = card.querySelector('a.card_rate_link');
      const href = link?.getAttribute('href') || '';
      const codeMatch = href.match(/no=(\d+)/);
      const code = codeMatch ? codeMatch[1] : '';

      // 배지: 첫 번째 = 기간("7개월", "24개월", "평생"), 나머지 = 혜택명
      const badges = Array.from(card.querySelectorAll('.badge_wrap .badge.badge_red'))
        .map(b => b.textContent.trim());
      const periodBadge = badges.find(b => /개월|평생|영구/.test(b)) || '';
      const benefitBadges = badges.filter(b => !/개월|평생|영구/.test(b));

      // 요금제명 (carrier 제거): ".title" = "LGU+ Sugar 7GB+1M"
      const titleEl = card.querySelector('.title');
      const carrierEl = titleEl?.querySelector('.text_light_color');
      const carrier = carrierEl?.textContent?.trim() || 'LGU+';
      const rawTitle = titleEl?.textContent?.trim() || '';
      const planName = rawTitle.replace(carrier, '').trim();

      // 스펙 항목
      const descItems = Array.from(card.querySelectorAll('.desc li'))
        .map(li => li.textContent.trim());

      // 가격 요소
      const originEl = card.querySelector('.origin');
      const originText = originEl?.textContent?.trim() || '';

      // .price 내부에서 직접 텍스트 노드 추출 (origin, ref 태그 제외)
      const priceDiv = card.querySelector('.price');
      let monthlyFeeText = '';
      if (priceDiv) {
        const clone = priceDiv.cloneNode(true);
        clone.querySelectorAll('p, span').forEach(el => el.remove());
        monthlyFeeText = clone.textContent.trim();
      }

      const refEl = card.querySelector('.price .ref');
      const refText = refEl?.textContent?.trim() || '';

      return {
        code, carrier, planName, periodBadge, benefitBadges,
        descItems, originText, monthlyFeeText, refText, network,
      };
    }), { network }
  );
}

async function crawl(log = console.log) {
  log('  [슈가모바일] 크롤링 시작...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const allPlans = [];
  const seenCodes = new Set();
  const collectedAt = new Date().toISOString();

  for (const { type, network } of PLAN_TYPES) {
    let rawItems;
    try {
      rawItems = await collectFromType(page, type, network);
    } catch (err) {
      log(`  [슈가모바일] [${type}] 오류: ${err.message.substring(0, 80)}`);
      continue;
    }
    log(`  [슈가모바일] [${type}] ${rawItems.length}건`);

    for (const item of rawItems) {
      const code = item.code || '';
      if (code && seenCodes.has(code)) continue;
      if (code) seenCodes.add(code);
      if (!item.planName) continue;

      const basePrice   = parsePrice(item.originText);
      const monthlyFee  = parsePrice(item.monthlyFeeText) || basePrice;

      // "*7개월 이후 21,980원" → 21,980
      const afterMatch = item.refText.match(/(\d+)개월\s*이후\s*([\d,]+)원/);
      const priceAfterDiscount = afterMatch ? parsePrice(afterMatch[2]) : null;

      // 할인 기간
      const periodMatch = item.periodBadge.match(/(\d+개월|평생|영구)/);
      const discountPeriod = (monthlyFee && basePrice && monthlyFee < basePrice && periodMatch)
        ? (periodMatch[1] === '영구' ? '평생' : periodMatch[1]) : '-';

      const data  = parseData(item.descItems[0]);
      const qos   = parseQos(item.descItems[0]);
      const voice = parseVoice(item.descItems[1]);
      const sms   = parseSms(item.descItems[2]);
      const benefits = item.benefitBadges.join(' / ') || '-';

      const networkType = /(?<!\d)5G(?!B)/i.test(item.planName) ? '5G' : item.network;

      allPlans.push({
        company:              '슈가모바일',
        carrier:              item.carrier || 'LGU+',
        network_type:         networkType,
        plan_type:            '유심',
        plan_name:            item.planName,
        plan_code:            code,
        voice,
        sms,
        data,
        qos,
        benefits,
        base_price:           basePrice,
        monthly_fee:          monthlyFee,
        price_after_discount: priceAfterDiscount,
        discount_period:      discountPeriod,
        source_url:           SOURCE_URL,
        collected_at:         collectedAt,
        _operator:            'sugar',
      });
    }
  }

  await browser.close();
  log(`  [슈가모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
