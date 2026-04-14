/**
 * 중소사업자 요금제 통합 크롤러 + 일별 비교 리포트
 *
 * 출력 항목:
 * 회사명 / 통신사 / 기술방식 / 분류 / 요금제명 /
 * 음성(분) / 문자(건) / 데이터 / QoS / 추가혜택 /
 * 기본료 / MM/DD(전일) / MM/DD(당일) / GAP / 할인기간
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const { crawl: crawlFreet } = require('./crawlers/small/freet');

const OUTPUT_DIR = path.join(__dirname, '../output/small');
const LOG_DIR = path.join(__dirname, '../logs');

const OPERATORS = [
  { key: 'freet', label: '프리티', crawl: crawlFreet },
];

// 날짜 유틸
function todayStr() {
  const d = new Date();
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}
function isoDate() {
  return new Date().toISOString().substring(0, 10).replace(/-/g, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, 'small_merge.log'), line + '\n', 'utf8'); } catch(e) {}
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 이전 스냅샷 로드 (plan_code → monthly_fee 맵) */
function loadPrevSnapshot(operatorKey) {
  const fp = path.join(OUTPUT_DIR, `${operatorKey}_snapshot.json`);
  if (!fs.existsSync(fp)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    // { plan_code: monthly_fee } 형태
    return data;
  } catch(e) { return {}; }
}

/** 현재 스냅샷 저장 */
function saveSnapshot(operatorKey, plans) {
  const snapshot = {};
  plans.forEach(p => {
    if (p.plan_code) snapshot[p.plan_code] = p.monthly_fee;
    else snapshot[p.plan_name] = p.monthly_fee; // plan_code 없을 때 이름으로
  });
  const fp = path.join(OUTPUT_DIR, `${operatorKey}_snapshot.json`);
  fs.writeFileSync(fp, JSON.stringify(snapshot, null, 2), 'utf8');
}

/**
 * GAP 계산
 * - 전일 데이터 없음: "NEW"
 * - 당일 비노출 (없어진 경우): "비노출" (호출 측에서 처리)
 * - 가격 동일: "-"
 * - 가격 차이: 부호 포함 숫자 (예: -1000, +2000)
 */
function calcGap(prevFee, currFee) {
  if (prevFee === undefined || prevFee === null) return 'NEW';
  if (currFee === null) return '비노출';
  const diff = currFee - prevFee;
  if (diff === 0) return '-';
  return diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
}

/** 엑셀 저장 */
async function saveExcel(rows, filename) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('중소사업자 요금제');

  const today = todayStr();
  const yesterday = yesterdayStr();

  const COLS = [
    { header: '회사명',       key: 'company',               width: 12 },
    { header: '통신사',       key: 'carrier',               width: 8 },
    { header: '기술방식',     key: 'network_type',          width: 10 },
    { header: '분류',         key: 'plan_type',             width: 8 },
    { header: '요금제명',     key: 'plan_name',             width: 32 },
    { header: '음성/분',      key: 'voice',                 width: 10 },
    { header: '문자/건',      key: 'sms',                   width: 10 },
    { header: '데이터',       key: 'data',                  width: 16 },
    { header: 'QoS',          key: 'qos',                   width: 10 },
    { header: '추가혜택',     key: 'benefits',              width: 40 },
    { header: '기본료',       key: 'base_price',            width: 12 },
    { header: `${yesterday}(전일)`, key: 'prev_fee',        width: 14 },
    { header: `${today}(당일)`,     key: 'curr_fee',        width: 14 },
    { header: 'GAP',          key: 'gap',                   width: 10 },
    { header: '할인기간',     key: 'discount_period',       width: 12 },
    { header: '할인 후 금액', key: 'price_after_discount',  width: 14 },
  ];

  ws.columns = COLS;

  // 헤더 스타일
  ws.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C5F8A' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });

  for (const row of rows) {
    const r = ws.addRow(row);
    // GAP 색상
    const gapCell = r.getCell('gap');
    if (row.gap === 'NEW') {
      gapCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
      gapCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    } else if (row.gap === '비노출') {
      gapCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
      gapCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    } else if (row.gap && row.gap !== '-') {
      const isUp = row.gap.startsWith('+');
      gapCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isUp ? 'FFFF9999' : 'FFCCFFCC' } };
    }
    r.alignment = { vertical: 'middle' };
  }

  // 회사명으로 그룹 구분선 (회사명 바뀔 때 위쪽 테두리)
  let prevCompany = null;
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const company = row.getCell('company').value;
    if (company !== prevCompany && prevCompany !== null) {
      row.eachCell(cell => {
        cell.border = { ...cell.border, top: { style: 'medium', color: { argb: 'FF2C5F8A' } } };
      });
    }
    prevCompany = company;
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const fp = path.join(OUTPUT_DIR, filename);
  await wb.xlsx.writeFile(fp);
  log(`엑셀 저장: ${fp} (${rows.length}건)`);
}

async function main() {
  ensureDir(OUTPUT_DIR);
  const startTime = Date.now();
  log('=== 중소사업자 요금제 크롤링 시작 ===');

  const today = todayStr();
  const yesterday = yesterdayStr();

  const allRows = [];

  for (const [idx, op] of OPERATORS.entries()) {
    log(`\n[${idx+1}/${OPERATORS.length}] ${op.label} 수집 시작`);
    let plans = [];

    try {
      plans = await op.crawl(log);
      log(`[${idx+1}/${OPERATORS.length}] ${op.label} 완료: ${plans.length}건`);
    } catch(e) {
      log(`[${idx+1}/${OPERATORS.length}] ${op.label} 실패: ${e.message}`);
    }

    // 이전 스냅샷 로드
    const prevSnapshot = loadPrevSnapshot(op.key);
    const prevKeys = new Set(Object.keys(prevSnapshot));
    const currKeys = new Set();

    for (const p of plans) {
      const key = p.plan_code || p.plan_name;
      currKeys.add(key);
      const prevFee = prevSnapshot[key] ?? null;

      allRows.push({
        company:         p.company,
        carrier:         p.carrier,
        network_type:    p.network_type,
        plan_type:       p.plan_type,
        plan_name:       p.plan_name,
        voice:           p.voice,
        sms:             p.sms,
        data:            p.data,
        qos:             p.qos || '-',
        benefits:              p.benefits || '-',
        base_price:            p.base_price,
        prev_fee:              prevFee,
        curr_fee:              p.monthly_fee,
        gap:                   calcGap(prevFee, p.monthly_fee),
        discount_period:       p.discount_period,
        price_after_discount:  p.price_after_discount ?? null,
      });
    }

    // 비노출 요금제 (전일엔 있었지만 당일엔 없는 것)
    for (const key of prevKeys) {
      if (!currKeys.has(key)) {
        allRows.push({
          company:              op.label,
          carrier:              '-',
          network_type:         '-',
          plan_type:            '-',
          plan_name:            key,
          voice:                '-',
          sms:                  '-',
          data:                 '-',
          qos:                  '-',
          benefits:             '-',
          base_price:           null,
          prev_fee:             prevSnapshot[key],
          curr_fee:             null,
          gap:                  '비노출',
          discount_period:      '-',
          price_after_discount: null,
        });
      }
    }

    // 스냅샷 갱신 (비노출 제외, 정상 수집된 것만)
    saveSnapshot(op.key, plans);

    if (idx < OPERATORS.length - 1) await sleep(500);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\n=== 통합 완료: ${allRows.length}건 (${elapsed}초) ===`);

  // JSON 저장
  const jsonPath = path.join(OUTPUT_DIR, 'small_operators_plans.json');
  fs.writeFileSync(jsonPath, JSON.stringify(allRows, null, 2), 'utf8');
  log(`JSON 저장: ${jsonPath}`);

  // 엑셀 저장
  await saveExcel(allRows, `중소사업자_요금제현황_${isoDate()}.xlsx`);

  log('\n=== 완료 ===');
  return allRows;
}

if (require.main === module) {
  main().catch(err => {
    log(`오류: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = { main };
