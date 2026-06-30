/**
 * 7개 사업자 요금제 데이터 통합 크롤러
 *
 * KT M모바일 + 헬로모바일 + 유모바일 + 스카이라이프 + 우리WON모바일 + 리브엠모바일 + SK세븐모바일
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const { format } = require('@fast-csv/format');

const { crawl: crawlKTM } = require('./crawler');
const { crawl: crawlLGHello } = require('./crawlers/lghello');
const { crawl: crawlUPlus } = require('./crawlers/uplus');
const { crawl: crawlSkylife } = require('./crawlers/skylife');
const { crawl: crawlWooriwon } = require('./crawlers/wooriwon');
const { crawl: crawlLiivm } = require('./crawlers/liivm');
const { crawl: crawlSK7 } = require('./crawlers/sk7mobile');

const OUTPUT_DIR = path.join(__dirname, '../output');
const LOG_DIR = path.join(__dirname, '../logs');

/** 이전 통합 파일에서 특정 사업자 데이터 반환 (폴백용) */
function loadPreviousData(operatorLabel) {
  const fp = path.join(OUTPUT_DIR, 'all_operators_plans.json');
  if (!fs.existsSync(fp)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return all.filter(p => p.operator === operatorLabel);
  } catch { return []; }
}

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

async function runOne(key, label, crawlFn) {
  log(`[병렬] ${label} 수집 시작`);
  let plans = [];
  try {
    plans = await crawlFn(log);
    log(`[병렬] ${label} 완료: ${plans.length}건`);
  } catch (e) {
    log(`[병렬] ${label} 실패: ${e.message}`);
  }
  if (plans.length === 0) {
    const fb = loadPreviousData(label);
    if (fb.length > 0) { log(`  → ${label} 이전 이력 폴백: ${fb.length}건`); plans = fb; }
  }
  return { key, plans };
}

async function main() {
  const startTime = Date.now();
  log('=== 7개 사업자 요금제 통합 크롤링 시작 (병렬) ===');

  // 7개 사업자 동시 실행
  const crawlTasks = [
    { key: 'ktm',       label: 'KT M모바일',   crawlFn: crawlKTM },
    { key: 'lghello',   label: '헬로모바일',    crawlFn: crawlLGHello },
    { key: 'uplus',     label: '유모바일',      crawlFn: crawlUPlus },
    { key: 'skylife',   label: '스카이라이프',  crawlFn: crawlSkylife },
    { key: 'wooriwon',  label: '우리WON모바일', crawlFn: crawlWooriwon },
    { key: 'liivm',     label: '리브엠모바일',  crawlFn: crawlLiivm },
    { key: 'sk7mobile', label: 'SK세븐모바일',  crawlFn: crawlSK7 },
  ];

  const settled = await Promise.allSettled(
    crawlTasks.map(({ key, label, crawlFn }) => runOne(key, label, crawlFn))
  );

  const results = {};
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      results[r.value.key] = r.value.plans;
    }
  }
  // 누락된 key 보호
  for (const { key } of crawlTasks) {
    if (!results[key]) results[key] = [];
  }

  // 통합
  const OPERATOR_LABELS = {
    ktm: 'KT M모바일',
    lghello: '헬로모바일',
    uplus: '유모바일',
    skylife: '스카이라이프',
    wooriwon: '우리WON모바일',
    liivm: '리브엠모바일',
    sk7mobile: 'SK세븐모바일',
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
