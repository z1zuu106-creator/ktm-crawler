/**
 * 이야기모바일 요금제 크롤러 (중소사업자)
 * 방식: Playwright DOM 파싱 (a.plan-item 셀렉터)
 * URL: https://www.eyagi.co.kr/shop/plan/list.php?tag=skt|lgt|kt
 */

const { chromium } = require('playwright');

const SOURCE_URL = 'https://www.eyagi.co.kr/shop/plan/list.php';

const CARRIER_TAGS = [
  { tag: 'skt', carrier: 'SKT' },
  { tag: 'lgt', carrier: 'LGU+' },
  { tag: 'kt',  carrier: 'KT' },
];

const MNO_MAP = { SKT: 'SKT', LGT: 'LGU+', KT: 'KT' };

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseData(dataFree) {
  if (!dataFree) return null;
  if (/무제한/.test(dataFree)) return '무제한';
  const m = dataFree.match(/([\d.]+)\s*(GB|MB)/i);
  if (m) return `${m[1]}${m[2].toUpperCase()}`;
  return dataFree || null;
}

function parseQos(qosText) {
  if (!qosText) return null;
  const m = qosText.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
  if (m) return `${m[1]}${m[2]}`;
  return null;
}

async function collectFromTag(page, tag) {
  await page.goto(`${SOURCE_URL}?tag=${tag}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // 더보기 반복 클릭으로 전체 로드
  let clicks = 0;
  while (clicks < 30) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(b => b.textContent.trim() === '더보기' && b.offsetParent !== null);
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(600);
    clicks++;
  }

  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a.plan-item')).map(el => ({
      mno:              el.getAttribute('data-mno-gubun') || '',
      code:             el.getAttribute('data-comm-code') || '',
      name:             el.querySelector('.name')?.textContent?.trim() || '',
      periodBadge:      el.querySelector('.badge.period')?.textContent?.trim() || '',
      dataFree:         el.querySelector('.spec-box .data .free')?.textContent?.trim() || '',
      qosText:          el.querySelector('.spec-box .data .qos')?.textContent?.trim() || '',
      callFree:         el.querySelector('.spec-box .call .free')?.textContent?.trim() || '',
      smsFree:          el.querySelector('.spec-box .sms .free')?.textContent?.trim() || '',
      basicPriceText:   el.querySelector('.price-box .basic-price')?.textContent?.trim() || '',
      currentPriceText: el.querySelector('.price-box .current-price')?.textContent?.trim() || '',
      orginPriceText:   el.querySelector('.price-box .orgin-price')?.textContent?.trim() || '',
    }))
  );
}

async function crawl(log = console.log) {
  log('  [이야기모바일] 크롤링 시작...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const allPlans = [];
  const seenCodes = new Set();
  const collectedAt = new Date().toISOString();

  for (const { tag, carrier: tagCarrier } of CARRIER_TAGS) {
    let rawItems;
    try {
      rawItems = await collectFromTag(page, tag);
    } catch (err) {
      log(`  [이야기모바일] [${tag}] 오류: ${err.message.substring(0, 80)}`);
      continue;
    }
    log(`  [이야기모바일] [${tag}] ${rawItems.length}건`);

    for (const item of rawItems) {
      const code = item.code || '';
      if (code && seenCodes.has(code)) continue;
      if (code) seenCodes.add(code);
      if (!item.name) continue;

      const carrier = MNO_MAP[item.mno] || tagCarrier;
      const networkType = /(?<!\d)5G(?!B)/i.test(item.name) ? '5G' : 'LTE';

      const basePrice   = parsePrice(item.basicPriceText);
      const currentPrice = parsePrice(item.currentPriceText);
      const monthlyFee  = currentPrice || basePrice;

      // "12개월 후 14,300원" → 14,300
      const afterMatch = item.orginPriceText.match(/(\d+)개월\s*후\s*([\d,]+)원/);
      const priceAfterDiscount = afterMatch ? parsePrice(afterMatch[2]) : null;

      // "12개월 할인" → "12개월"
      const periodMatch = item.periodBadge.match(/(\d+개월|평생)/);
      const discountPeriod = (monthlyFee && basePrice && monthlyFee < basePrice && periodMatch)
        ? periodMatch[1] : '-';

      allPlans.push({
        company:              '이야기모바일',
        carrier,
        network_type:         networkType,
        plan_type:            '유심',
        plan_name:            item.name,
        plan_code:            code,
        voice:                item.callFree || '기본제공',
        sms:                  item.smsFree  || '기본제공',
        data:                 parseData(item.dataFree),
        qos:                  parseQos(item.qosText),
        benefits:             '-',
        base_price:           basePrice,
        monthly_fee:          monthlyFee,
        price_after_discount: priceAfterDiscount,
        discount_period:      discountPeriod,
        source_url:           SOURCE_URL,
        collected_at:         collectedAt,
        _operator:            'iyagi',
      });
    }
  }

  await browser.close();
  log(`  [이야기모바일] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
