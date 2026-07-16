/**
 * 스카이라이프 모바일 요금제 크롤러
 * 방식: 목록 페이지에서 슬러그 수집 → 각 상세 페이지 파싱
 * URL: https://www.skylife.co.kr/product/mobile/all
 */

const { chromium } = require('playwright');

const LIST_URL = 'https://www.skylife.co.kr/product/mobile/all';
const DETAIL_BASE = 'https://www.skylife.co.kr/product/mobile/goods';
const SOURCE_URL = LIST_URL;

function parsePrice(str) {
  if (!str) return null;
  const n = parseInt(String(str).replace(/[,\s원월혜택가]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function extractQoS(texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = t.match(/(\d+(?:\.\d+)?)\s*(Mbps|Kbps)/i);
    if (m) return { qos_speed: `${m[1]}${m[2]}`, qos_raw: t };
  }
  return { qos_speed: null, qos_raw: null };
}

function extractData(lines) {
  // "데이터 200 GB", "데이터 110 GB", "데이터 7 GB" 같은 패턴
  const dataLine = lines.find(l => l.startsWith('데이터') && l.match(/\d/));
  if (dataLine) {
    const match = dataLine.match(/[\d.]+\s*(?:GB|MB)/i);
    if (match) {
      const normalized = match[0].replace(/\s+/, '');
      return { raw: dataLine, normalized };
    }
    if (dataLine.includes('무제한')) return { raw: dataLine, normalized: '무제한' };
  }
  return { raw: null, normalized: null };
}

function extractVoice(lines) {
  // 마케팅 문구 제외: "통화는 무제한~ 데이터는..." 같은 홍보 텍스트 필터링
  const v = lines.find(l => {
    if (!l.startsWith('통화')) return false;
    if (l.includes('무제한 데이터')) return false;
    const cleaned = l.replace(/^통화\s*/, '').trim();
    // 마케팅 특수문자·긴 문장 제외
    if (/[?!~]/.test(cleaned)) return false;
    if (cleaned.length > 30) return false;
    return true;
  });
  if (!v) return '기본제공';
  const cleaned = v.replace(/^통화\s*/, '').trim();
  return cleaned || '기본제공';
}

function extractSMS(lines) {
  const s = lines.find(l => l.startsWith('메시지'));
  if (!s) return '기본제공';
  return s.replace(/^메시지\s*/, '').trim() || '기본제공';
}

function extractNetwork(planName, lines) {
  if (planName?.includes('5G')) return '5G';
  const found = lines.find(l => l.includes('5G') || l.includes('LTE'));
  if (found?.includes('5G')) return '5G';
  return 'LTE';
}

async function collectSlugs(page) {
  return page.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('a[href*="/product/mobile/goods/"]').forEach(a => {
      const m = a.getAttribute('href')?.match(/\/goods\/([^/?#]+)/);
      if (m) seen.add(m[1]);
    });
    return [...seen];
  });
}

async function parsePlanPage(page, slug) {
  await page.goto(`${DETAIL_BASE}/${slug}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  return page.evaluate(() => {
    const allLines = document.body.innerText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 1 && l.length < 200);

    // QoS 텍스트: 아코디언 detail 요소에서
    const detailTexts = Array.from(
      document.querySelectorAll('[class*="flex"][class*="items-center"][class*="py-4"]')
    ).map(el => el.textContent.trim()).filter(t => t.match(/GB|Mbps|통화|문자/));

    // 전체 텍스트에서 QoS 패턴도 추출
    const qosDescLine = allLines.find(l => l.match(/소진\s*후.*Mbps|최대.*Mbps|Mbps.*무제한/));

    return { allLines, detailTexts, qosDescLine };
  });
}

async function crawl(log = console.log) {
  log('  [스카이라이프] 목록 페이지에서 슬러그 수집 중...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // 목록 페이지 로드
  await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // "더보기" 버튼을 반복 클릭해서 전체 로드 (최대 20회)
  let moreClicks = 0;
  while (moreClicks < 20) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const moreBtn = btns.find(b => b.textContent.trim() === '더보기');
      if (moreBtn && moreBtn.offsetParent !== null) { moreBtn.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(800);
    moreClicks++;
  }
  log(`  [스카이라이프] 더보기 클릭 ${moreClicks}회`);

  // 전체보기로 슬러그 수집
  let allSlugs = await collectSlugs(page);

  // 필터 탭도 순회 (더보기 포함) → 전체보기에 없는 슬러그 추가 수집
  const FILTER_TABS = ['라이프핏', '데이터 무제한', '통화 무제한', '만원 이하', '시니어', '주니어', '실속 요금제', '5G+', '안심', '스마트기기', '복지 전용'];
  for (const tabName of FILTER_TABS) {
    const tabClicked = await page.evaluate((name) => {
      // 필터 탭 버튼 찾기
      const els = Array.from(document.querySelectorAll('button, li, span, a'));
      const el = els.find(e =>
        e.textContent.trim() === name &&
        (e.tagName === 'BUTTON' || e.closest('nav, ul, [class*="tab"], [class*="filter"]'))
      );
      if (el) { el.click(); return true; }
      return false;
    }, tabName);

    if (!tabClicked) continue;
    await page.waitForTimeout(500);

    // 해당 탭에서도 더보기 클릭
    let tabMoreClicks = 0;
    while (tabMoreClicks < 20) {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const moreBtn = btns.find(b => b.textContent.trim() === '더보기');
        if (moreBtn && moreBtn.offsetParent !== null) { moreBtn.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(800);
      tabMoreClicks++;
    }

    const tabSlugs = await collectSlugs(page);
    const newOnes = tabSlugs.filter(s => !allSlugs.includes(s));
    if (newOnes.length > 0) {
      log(`  [스카이라이프] [${tabName}] 탭에서 신규 ${newOnes.length}개 발견`);
      allSlugs = [...allSlugs, ...newOnes];
    }
  }

  const slugs = allSlugs;
  log(`  [스카이라이프] 수집 슬러그 총 ${slugs.length}개 (병렬 처리)`);

  const collectedAt = new Date().toISOString();
  const allPlans = [];

  // 슬러그 파싱을 병렬(5개 동시)로 처리하여 속도 개선
  const CONCURRENCY = 5;
  const queue = [...slugs];

  // 5개 페이지 동시 생성
  const workerPages = await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, () => context.newPage())
  );

  await Promise.all(workerPages.map(async (wPage) => {
    while (true) {
      const slug = queue.shift();
      if (!slug) break;

      try {
        const { allLines, detailTexts, qosDescLine } = await parsePlanPage(wPage, slug);

        const moIndices = allLines.map((l, i) => l === '모바일' ? i : -1).filter(i => i >= 0);
        const moIdx = moIndices.length > 0 ? moIndices[moIndices.length - 1] : -1;
        const planName = moIdx >= 0 ? allLines[moIdx + 1] : allLines.find(l => l.match(/GB|무제한/));

        // 이름 추출 실패 시 슬러그가 그대로 저장되지 않도록 건너뜀
        if (!planName?.trim()) {
          log(`    ? [스카이라이프] ${slug} - 이름 미추출, 건너뜀`);
          continue;
        }

        const priceLine1 = allLines.find(l => l.match(/^월\s*[\d,]+원$/));
        const priceNum1 = parsePrice(priceLine1);
        const priceLine2 = allLines.find(l => l.match(/^[\d,]+$/) && l.replace(/,/g,'').length >= 4 && !l.includes('0000'));
        const priceNum2 = parsePrice(priceLine2);

        let base_price = null, benefit_price = null;
        let base_price_text = null, benefit_price_text = null;
        if (priceNum1 && priceNum2) {
          const bigger = Math.max(priceNum1, priceNum2);
          const smaller = Math.min(priceNum1, priceNum2);
          base_price = bigger;
          benefit_price = smaller !== bigger ? smaller : null;
          base_price_text = `월 ${bigger.toLocaleString()}원`;
          benefit_price_text = benefit_price ? `혜택가 월 ${smaller.toLocaleString()}원` : null;
        } else if (priceNum1) {
          base_price = priceNum1;
          base_price_text = `월 ${priceNum1.toLocaleString()}원`;
        } else if (priceNum2) {
          base_price = priceNum2;
          base_price_text = `월 ${priceNum2.toLocaleString()}원`;
        }

        const dataLines = allLines.filter(l => l.startsWith('데이터'));
        const { raw: data_allowance_raw, normalized: data_allowance_normalized } = extractData(dataLines);
        const voice_allowance = extractVoice(allLines);
        const sms_allowance = extractSMS(allLines);
        const { qos_speed, qos_raw } = extractQoS([...detailTexts, qosDescLine, data_allowance_raw]);
        const network_type = extractNetwork(planName, detailTexts);

        allPlans.push({
          plan_name: planName?.trim() || slug,
          plan_code: slug,
          data_allowance_raw,
          data_allowance_normalized,
          qos_raw,
          qos_speed,
          voice_allowance,
          sms_allowance,
          base_price_text,
          base_price,
          benefit_price_text,
          benefit_price,
          plan_type: ['유심'],
          partnership_flag: false,
          network_type,
          product_group: '전체',
          source_url: SOURCE_URL,
          collected_at: collectedAt,
          _operator: 'skylife',
        });

        log(`    ✓ [스카이라이프] ${planName} | ${data_allowance_normalized} | QoS:${qos_speed} | ${base_price}원`);
      } catch (err) {
        log(`    ✗ [스카이라이프] ${slug} 실패: ${err.message.substring(0, 80)}`);
      }
    }
  }));

  await Promise.all(workerPages.map(p => p.close()));
  await browser.close();
  log(`  [스카이라이프] 최종 ${allPlans.length}건`);
  return allPlans;
}

module.exports = { crawl };
