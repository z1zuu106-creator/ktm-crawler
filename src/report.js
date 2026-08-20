/**
 * 일간 보고서 생성
 * - output/history/plans_YYYYMMDD.json 에 날짜별 이력 저장
 * - 전일 vs 당일 비교 → GAP / NEW / 비노출
 * - 컬럼 헤더에 실제 날짜 표시: "4/8(전일)", "4/9(당일)"
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR   = path.join(__dirname, '../output');
const HISTORY_DIR  = path.join(OUTPUT_DIR, 'history');
const REGISTRY_FILE = path.join(OUTPUT_DIR, 'new_plans_registry.json');

// ── 신규 요금제 레지스트리 ─────────────────────────────────────────────────────
// 구조: { "회사명||요금제명": "20260410", ... }

function loadRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch(e) {}
  }
  return {};
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

// ── 날짜 유틸 ─────────────────────────────────────────────────────────────────

/** "20260409" → "4/9" */
function toMD(dateStr) {
  return `${parseInt(dateStr.slice(4, 6))}/${parseInt(dateStr.slice(6, 8))}`;
}

/** 두 날짜 문자열 간 일 수 차이 */
function dayDiff(fromStr, toStr) {
  const parse = s => new Date(
    parseInt(s.slice(0,4)), parseInt(s.slice(4,6)) - 1, parseInt(s.slice(6,8))
  );
  return Math.round((parse(toStr) - parse(fromStr)) / 86400000);
}

/**
 * 전일 컬럼 레이블 결정
 * - 실제 전날: "4/8(전일)"
 * - 1일 이상 간격: "4/8(기준일)" — 전일이 아님을 명시
 */
function prevLabel(prevDateStr, todayDateStr) {
  if (!prevDateStr) return '전일';
  const diff = dayDiff(prevDateStr, todayDateStr);
  const md = toMD(prevDateStr);
  return diff <= 1 ? `${md}(전일)` : `${md}(기준일)`;
}

// ── 이력 관리 ─────────────────────────────────────────────────────────────────

/**
 * history/ 디렉토리에서 날짜 순 정렬된 파일 목록 반환
 * @returns {Array<{dateStr: string, filepath: string}>}
 */
function getHistoryFiles() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

  return fs.readdirSync(HISTORY_DIR)
    .filter(f => f.match(/^plans_\d{8}\.json$/))
    .map(f => ({
      dateStr:  f.match(/plans_(\d{8})/)[1],
      filepath: path.join(HISTORY_DIR, f),
    }))
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr));  // 오름차순 (최신이 마지막)
}

/**
 * 오늘 데이터를 history에 저장
 */
function saveToHistory(today, todayDateStr) {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const fp = path.join(HISTORY_DIR, `plans_${todayDateStr}.json`);
  fs.writeFileSync(fp, JSON.stringify(today, null, 2), 'utf8');
  console.log(`이력 저장: ${fp}`);
}

// ── 파서 유틸 ─────────────────────────────────────────────────────────────────

function planKey(p) {
  return `${p.operator}||${p.plan_name}`;
}

function effectivePrice(p) {
  return p.benefit_price ?? p.base_price;
}

function dataGB(normalized) {
  if (!normalized) return '';
  const gb = normalized.match(/^([\d.]+)\s*GB$/i);
  if (gb) return parseFloat(gb[1]);
  const mb = normalized.match(/^([\d.]+)\s*MB$/i);
  if (mb) return parseFloat(mb[1]) / 1000;
  return normalized;
}

function mainBenefit(p) {
  if (!p.partnership_flag) return '';
  const g = p.product_group || '';
  if (g === '전체' || !g) return '';
  return g.length > 30 ? g.substring(0, 30) + '…' : g;
}

// ── 비교 로직 ─────────────────────────────────────────────────────────────────

/**
 * 요금제 비교 + 신규 레지스트리 갱신
 * @param {Array}  today        당일 요금제 목록
 * @param {Array}  prev         전일 요금제 목록 (없으면 null)
 * @param {Object} registry     { planKey: "YYYYMMDD" } — 신규 첫 등장일 맵 (수정됨)
 * @param {string} todayDateStr "20260410"
 */
function compare(today, prev, registry, todayDateStr) {
  const todayMonth = todayDateStr.slice(0, 6); // "202604"
  const prevMap = prev
    ? new Map(prev.map(p => [planKey(p), p]))
    : new Map();

  const todaySet = new Set(today.map(planKey));
  const rows = [];

  for (const plan of today) {
    const key = planKey(plan);
    const prevPlan = prevMap.get(key);
    const 당일 = effectivePrice(plan);
    const 전일 = prevPlan != null ? effectivePrice(prevPlan) : null;

    let gap;
    let bigo = '';  // 비고

    if (!prevPlan) {
      // 첫 등장 → 레지스트리에 기록
      registry[key] = registry[key] || todayDateStr;
    }

    const firstSeen = registry[key];

    if (firstSeen && firstSeen.slice(0, 6) === todayMonth) {
      // 이번 달에 처음 등장한 신규 요금제 → 달 내내 "신규(M/D)" 표시
      const md = toMD(firstSeen);
      gap  = `신규(${md})`;
      bigo = `출시: ${md}`;
    } else if (전일 !== null && 당일 !== 전일) {
      gap = 당일 - 전일;
    } else {
      gap = null;
    }

    rows.push({ ...plan, 전일, 당일, gap, bigo });
  }

  // 비노출
  for (const [key, prevPlan] of prevMap) {
    if (!todaySet.has(key)) {
      // 슬러그 형태 요금제(pl로 시작하는 영숫자)는 비노출 목록에서 제외
      if (/^pl[a-z0-9]+$/i.test(prevPlan.plan_name || '')) continue;
      rows.push({ ...prevPlan, 전일: effectivePrice(prevPlan), 당일: null, gap: '비노출', bigo: '' });
    }
  }

  // 정렬
  rows.sort((a, b) => {
    const opOrder = ['KT M모바일', '헬로모바일', '유모바일', '스카이라이프', '우리WON모바일', '리브엠모바일', 'SK세븐모바일'];
    const oa = opOrder.indexOf(a.operator);
    const ob = opOrder.indexOf(b.operator);
    if (oa !== ob) return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
    if (a.network_type !== b.network_type) return a.network_type < b.network_type ? -1 : 1;
    return (a.plan_name || '').localeCompare(b.plan_name || '', 'ko');
  });

  return {
    rows,
    summary: {
      newPlans:     rows.filter(r => typeof r.gap === 'string' && r.gap.startsWith('신규')),
      hiddenPlans:  rows.filter(r => r.gap === '비노출'),
      changedPlans: rows.filter(r => typeof r.gap === 'number'),
    },
  };
}

// ── Excel 생성 ────────────────────────────────────────────────────────────────

const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const BASE_FONT = { size: 10 };

/**
 * 동적 헤더 생성 (전일/당일 날짜 반영)
 * @param {string|null} prevDateStr  "20260408" 또는 null
 * @param {string}      todayDateStr "20260409"
 */
function buildHeaders(prevDateStr, todayDateStr) {
  const pLabel     = prevLabel(prevDateStr, todayDateStr);
  const todayLabel = `${toMD(todayDateStr)}(당일)`;

  return [
    { key: 'operator',   label: '회사명',      width: 14 },
    { key: 'plan_type',  label: '분류',        width: 8  },
    { key: 'network',    label: '기술방식',    width: 9  },
    { key: 'plan_name',  label: '요금제명',    width: 36 },
    { key: 'voice',      label: '음성/분',     width: 10 },
    { key: 'sms',        label: '문자/건',     width: 10 },
    { key: 'data',       label: '데이터/GB',   width: 12 },
    { key: 'qos',        label: 'QOS',         width: 8  },
    { key: 'benefit',    label: '주가혜택',    width: 30 },
    { key: 'base_price', label: '기본료',      width: 10 },
    { key: '전일',        label: pLabel,       width: 12 },
    { key: '당일',        label: todayLabel,   width: 12 },
    { key: 'gap',        label: 'GAP',         width: 14 },
    { key: 'bigo',       label: '비고',        width: 14 },
  ];
}

function gapStyle(gap) {
  if (typeof gap === 'string' && gap.startsWith('신규'))
    return { font: { bold: true, color: { argb: 'FF0070C0' }, size: 10 } };
  if (gap === '비노출') return { font: { color: { argb: 'FF808080' }, size: 10, italic: true } };
  if (typeof gap === 'number' && gap > 0) return { font: { color: { argb: 'FFFF0000' }, size: 10 } };
  if (typeof gap === 'number' && gap < 0) return { font: { color: { argb: 'FF00AA00' }, size: 10 } };
  return { font: BASE_FONT };
}

function gapDisplay(gap) {
  if (gap === null || gap === undefined) return '-';
  if (gap === '비노출') return gap;
  if (typeof gap === 'string' && gap.startsWith('신규')) return gap;
  if (typeof gap === 'number') {
    return gap > 0 ? `+${gap.toLocaleString()}` : gap.toLocaleString();
  }
  return '-';
}

function isNewGap(gap) {
  return typeof gap === 'string' && gap.startsWith('신규');
}

/**
 * 워크시트 하나를 rows 배열로 채움 (헤더 포함)
 */
function fillSheet(ws, HEADERS, rows) {
  ws.columns = HEADERS.map(h => ({ key: h.key, width: h.width }));

  // 헤더 행
  const hdrRow = ws.addRow(HEADERS.map(h => h.label));
  hdrRow.eachCell(cell => {
    cell.fill = HDR_FILL;
    cell.font = HDR_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  });
  hdrRow.height = 18;

  // 데이터 행
  for (const [i, r] of rows.entries()) {
    const gapVal   = r.gap;
    const isHidden = gapVal === '비노출';
    const isNew    = isNewGap(gapVal);

    const vals = {
      operator:   r.operator || '',
      plan_type:  Array.isArray(r.plan_type) ? r.plan_type[0] : (r.plan_type || ''),
      network:    r.network_type || '',
      plan_name:  r.plan_name || '',
      voice:      r.voice_allowance || '',
      sms:        r.sms_allowance || '',
      data:       dataGB(r.data_allowance_normalized),
      qos:        r.qos_speed || '',
      benefit:    mainBenefit(r),
      base_price: isHidden ? '' : (r.base_price ?? ''),
      '전일':      r['전일'] ?? '',
      '당일':      r['당일'] ?? '',
      gap:        gapDisplay(gapVal),
      bigo:       r.bigo || '',
    };
    const rowData = HEADERS.map(h => vals[h.key] ?? '');

    const dataRow = ws.addRow(rowData);
    dataRow.height = 16;

    dataRow.eachCell((cell, colNum) => {
      cell.font = { ...BASE_FONT };
      cell.alignment = { vertical: 'middle' };

      const hLabel = HEADERS[colNum - 1]?.label || '';

      if (hLabel === '기본료' || hLabel.includes('전일') || hLabel.includes('당일')) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      }
      if (hLabel === '데이터/GB' && typeof cell.value === 'number') {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.numFmt = '#,##0.##';
      }

      if (i % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      }

      if (isHidden) {
        cell.font = { ...BASE_FONT, color: { argb: 'FF999999' }, italic: true };
      }
    });

    // GAP 셀 스타일 (끝에서 두 번째 컬럼)
    const gapColIdx = HEADERS.findIndex(h => h.key === 'gap') + 1;
    const gapCell = dataRow.getCell(gapColIdx);
    gapCell.font = { ...gapCell.font, ...gapStyle(gapVal).font };
    gapCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // 비고 셀 (신규면 파란색 이탤릭)
    const bigoColIdx = HEADERS.findIndex(h => h.key === 'bigo') + 1;
    const bigoCell = dataRow.getCell(bigoColIdx);
    bigoCell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (isNew) {
      bigoCell.font = { ...BASE_FONT, color: { argb: 'FF0070C0' }, italic: true };
    }

    // 신규 행 배경 (연파란)
    if (isNew) {
      dataRow.eachCell(cell => {
        if (!cell.fill || cell.fill.fgColor?.argb === 'FFF2F2F2') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
        }
      });
    }
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: HEADERS.length },
  };
}

const OPERATOR_ORDER = [
  'KT M모바일', '헬로모바일', '유모바일', '스카이라이프',
  '우리WON모바일', '리브엠모바일', 'SK세븐모바일',
];

async function generateExcel(rows, todayDateStr, prevDateStr) {
  const HEADERS = buildHeaders(prevDateStr, todayDateStr);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'KTM-Crawler';
  wb.created = new Date();

  // ① 전체 시트
  const wsAll = wb.addWorksheet('전체', { views: [{ state: 'frozen', ySplit: 1 }] });
  fillSheet(wsAll, HEADERS, rows);

  // ② 회사별 시트
  for (const opName of OPERATOR_ORDER) {
    const opRows = rows.filter(r => r.operator === opName);
    if (opRows.length === 0) continue;

    // 시트명은 최대 31자 (Excel 제한)
    const sheetName = opName.slice(0, 31);
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

    // 회사별 시트는 '회사명' 컬럼 제외
    const companyHeaders = HEADERS.filter(h => h.key !== 'operator');
    fillSheet(ws, companyHeaders, opRows);
  }

  const filename = `요금제현황_${todayDateStr}.xlsx`;
  const filepath = path.join(OUTPUT_DIR, filename);
  await wb.xlsx.writeFile(filepath);
  return filepath;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const todayDateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 오늘 수집 데이터
  const todayPath = path.join(OUTPUT_DIR, 'all_operators_plans.json');
  if (!fs.existsSync(todayPath)) {
    throw new Error(`오늘 수집 데이터 없음: ${todayPath}`);
  }
  const today = JSON.parse(fs.readFileSync(todayPath, 'utf8'));

  // 오늘 이력 저장
  saveToHistory(today, todayDateStr);

  // 이력 파일 목록 (오늘 제외한 최근 파일 = 전일)
  const histFiles = getHistoryFiles().filter(f => f.dateStr !== todayDateStr);

  let prev         = null;
  let prevDateStr  = null;
  let prev2DateStr = null;

  if (histFiles.length >= 1) {
    const latestHist = histFiles[histFiles.length - 1];  // 전일
    prevDateStr = latestHist.dateStr;
    prev = JSON.parse(fs.readFileSync(latestHist.filepath, 'utf8'));
    console.log(`전일(${toMD(prevDateStr)}): ${prev.length}건`);
  } else {
    console.log('전일 데이터 없음 → 첫 실행, 모두 신규로 처리');
  }

  if (histFiles.length >= 2) {
    const prev2Hist = histFiles[histFiles.length - 2];   // 전전일
    prev2DateStr = prev2Hist.dateStr;
    console.log(`전전일(${toMD(prev2DateStr)}): 이력 보관됨`);
  }

  console.log(`당일(${toMD(todayDateStr)}): ${today.length}건`);

  // 신규 요금제 레지스트리 로드 (첫 등장일 추적)
  const registry = loadRegistry();

  // 비교
  const { rows, summary } = compare(today, prev, registry, todayDateStr);

  // 레지스트리 저장 (새로 발견된 신규 요금제 반영)
  saveRegistry(registry);

  console.log(`변동 요약:`);
  console.log(`  신규: ${summary.newPlans.length}건`);
  console.log(`  비노출: ${summary.hiddenPlans.length}건`);
  console.log(`  가격변동: ${summary.changedPlans.length}건`);

  // Excel 생성 (날짜 레이블 포함)
  const excelPath = await generateExcel(rows, todayDateStr, prevDateStr);
  console.log(`Excel 저장: ${excelPath}`);

  // report_meta 저장 (notify.js에서 사용)
  const pLabel     = prevLabel(prevDateStr, todayDateStr);
  const todayLabel = `${toMD(todayDateStr)}(당일)`;

  const reportMeta = {
    todayDateStr,
    prevDateStr,
    prev2DateStr,
    prevLabel: pLabel,
    todayLabel,
    excelPath,
    totalToday: today.length,
    summary: {
      newCount:     summary.newPlans.length,
      hiddenCount:  summary.hiddenPlans.length,
      changedCount: summary.changedPlans.length,
      newPlans: summary.newPlans.map(p => ({
        operator: p.operator, plan_name: p.plan_name, network_type: p.network_type,
        data: dataGB(p.data_allowance_normalized), qos: p.qos_speed, 당일: p['당일'], bigo: p.bigo,
      })),
      hiddenPlans: summary.hiddenPlans.map(p => ({
        operator: p.operator, plan_name: p.plan_name, network_type: p.network_type,
        전일: p['전일'],
      })),
      changedPlans: summary.changedPlans.map(p => ({
        operator: p.operator, plan_name: p.plan_name,
        전일: p['전일'], 당일: p['당일'], gap: p.gap,
      })),
    },
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'report_meta.json'),
    JSON.stringify(reportMeta, null, 2),
    'utf8'
  );

  return reportMeta;
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main, compare, generateExcel };
