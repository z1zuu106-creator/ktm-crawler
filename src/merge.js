/**
 * 6개 사업자 요금제 데이터 통합 크롤러
 *
 * KT M모바일 + 헬로모바일 + 유모바일 + 스카이라이프 + 우리WON모바일 + 리브엠모바일
 */

const fs = require('fs');
const path = require('path');
const { format } = require('@fast-csv/format');

const { crawl: crawlKTM } = require('./crawler');
const { crawl: crawlLGHello } = require('./crawlers/lghello');
const { crawl: crawlUPlus } = require('./crawlers/uplus');
const { crawl: crawlSkylife } = require('./crawlers/skylife');
const { crawl: crawlWooriwon } = require('./crawlers/wooriwon');
const { crawl: crawlLiivm } = require('./crawlers/liivm');

const OUTPUT_DIR = path.join(__dirname, '../output');
const LOG_DIR = path.join(__dirname, '../logs');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'merge.log'), line + '\n', 'utf8');
}

function removeInternalFields(plan) {
  const out = { ...plan };
  Object.keys(out).filter(k => k.startsWith('_')).forEach(k => delete out[k]);
  return out;
}

async function saveCSV(plans, filename) {
  return new Promise((resolve, reject) => {
    const filepath = path.join(OUTPUT_DIR, filename);
    const ws = fs.createWriteStream(filepath, { encoding: 'utf8' });
    const csvStream = format({
      headers: [
        'operator', 'plan_name', 'plan_code',
        'data_allowance_raw', 'data_allowance_normalized',
        'qos_raw', 'qos_speed',
        'voice_allowance', 'sms_allowance',
        'base_price_text', 'base_price',
        'benefit_price_text', 'benefit_price',
        'plan_type', 'partnership_flag', 'network_type', 'product_group',
        'source_url', 'collected_at',
      ],
      writeBOM: true,
    });
    csvStream.pipe(ws);
    plans.forEach(p => csvStream.write({
      ...p,
      plan_type: Array.isArray(p.plan_type) ? p.plan_type.join(',') : p.plan_type,
    }));
    csvStream.end();
    ws.on('finish', () => { log(`CSV 저장: ${filepath} (${plans.length}건)`); resolve(); });
    ws.on('error', reject);
  });
}

async function main() {
  const startTime = Date.now();
  log('=== 6개 사업자 요금제 통합 크롤링 시작 ===');

  const results = {};

  // 1. KT M모바일 (API 기반, 빠름)
  log('\n[1/6] KT M모바일 수집 시작');
  try {
    results.ktm = await crawlKTM();
    log(`[1/6] KT M모바일 완료: ${results.ktm.length}건`);
  } catch (e) {
    log(`[1/6] KT M모바일 실패: ${e.message}`);
    results.ktm = [];
  }

  await sleep(500);

  // 2. 헬로모바일 (API 기반, 빠름)
  log('\n[2/6] 헬로모바일 수집 시작');
  try {
    results.lghello = await crawlLGHello(log);
    log(`[2/6] 헬로모바일 완료: ${results.lghello.length}건`);
  } catch (e) {
    log(`[2/6] 헬로모바일 실패: ${e.message}`);
    results.lghello = [];
  }

  await sleep(500);

  // 3. 유모바일 (Playwright, 보통 속도)
  log('\n[3/6] 유모바일 수집 시작');
  try {
    results.uplus = await crawlUPlus(log);
    log(`[3/6] 유모바일 완료: ${results.uplus.length}건`);
  } catch (e) {
    log(`[3/6] 유모바일 실패: ${e.message}`);
    results.uplus = [];
  }

  await sleep(500);

  // 4. 스카이라이프 (Playwright, 개별 페이지 순회)
  log('\n[4/6] 스카이라이프 수집 시작');
  try {
    results.skylife = await crawlSkylife(log);
    log(`[4/6] 스카이라이프 완료: ${results.skylife.length}건`);
  } catch (e) {
    log(`[4/6] 스카이라이프 실패: ${e.message}`);
    results.skylife = [];
  }

  await sleep(500);

  // 5. 우리WON모바일 (Playwright)
  log('\n[5/6] 우리WON모바일 수집 시작');
  try {
    results.wooriwon = await crawlWooriwon(log);
    log(`[5/6] 우리WON모바일 완료: ${results.wooriwon.length}건`);
  } catch (e) {
    log(`[5/6] 우리WON모바일 실패: ${e.message}`);
    results.wooriwon = [];
  }

  await sleep(500);

  // 6. 리브엠모바일 (API)
  log('\n[6/6] 리브엠모바일 수집 시작');
  try {
    results.liivm = await crawlLiivm(log);
    log(`[6/6] 리브엠모바일 완료: ${results.liivm.length}건`);
  } catch (e) {
    log(`[6/6] 리브엠모바일 실패: ${e.message}`);
    results.liivm = [];
  }

  // 통합
  const OPERATOR_LABELS = {
    ktm: 'KT M모바일',
    lghello: '헬로모바일',
    uplus: '유모바일',
    skylife: '스카이라이프',
    wooriwon: '우리WON모바일',
    liivm: '리브엠모바일',
  };

  const merged = [];
  for (const [key, plans] of Object.entries(results)) {
    for (const plan of plans) {
      const clean = removeInternalFields(plan);
      merged.push({ operator: OPERATOR_LABELS[key], ...clean });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\n=== 통합 완료: ${merged.length}건 (${elapsed}초) ===`);

  // 사업자별 요약
  for (const [key, label] of Object.entries(OPERATOR_LABELS)) {
    const cnt = merged.filter(p => p.operator === label).length;
    const qosCnt = merged.filter(p => p.operator === label && p.qos_speed).length;
    log(`  ${label}: ${cnt}건 (QoS 있음 ${qosCnt}건)`);
  }

  // 저장: JSON (사업자별 + 전체)
  const jsonPath = path.join(OUTPUT_DIR, 'all_operators_plans.json');
  fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), 'utf8');
  log(`\nJSON 저장: ${jsonPath}`);

  // 저장: CSV
  await saveCSV(merged, 'all_operators_plans.csv');

  // 사업자별 JSON도 저장
  for (const [key, plans] of Object.entries(results)) {
    if (plans.length === 0) continue;
    const fp = path.join(OUTPUT_DIR, `${key}_plans.json`);
    fs.writeFileSync(fp, JSON.stringify(plans.map(removeInternalFields), null, 2), 'utf8');
    log(`  개별 저장: ${fp}`);
  }

  log('\n=== 크롤링 완료 ===');
  return merged;
}

if (require.main === module) {
  main().catch(err => {
    log(`오류: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = { main };
