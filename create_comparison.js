/**
 * 중소사업자 요금제 비교표 생성
 * - output/small/small_operators_plans.json 에서 데이터 읽기
 * - 3개 조건별 통신망 최저가 추출
 * - 사용자 양식(사업자×요금제×통신망 + 월별 컬럼) 엑셀 생성
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const DATA_FILE = path.join(__dirname, 'output', 'small', 'small_operators_plans.json');
const OUT_DIR   = path.join(__dirname, 'output', 'small');

// ─── 통신망 정규화 ───────────────────────────────────────────────────────────
function normCarrier(c) {
  if (!c) return null;
  const u = c.toUpperCase();
  if (u === 'SKT') return 'SKT';
  if (u === 'KT')  return 'KT';
  if (u === 'LGU+' || u === 'LGT') return 'LG';
  return null; // CU 등 제외
}

// ─── 조건 매칭 ───────────────────────────────────────────────────────────────
function isUnlim(voice) {
  return !voice || voice === '기본제공' || voice.includes('무제한');
}

const CONDITIONS = [
  {
    key:   'cond1',
    label: '11GB+일2GB+3Mbps/통화무제한',
    match: p =>
      p.data  && p.data.includes('11GB') &&
      (p.data.includes('매일2GB') || p.data.includes('일2GB') || p.data.includes('+2GB')) &&
      p.qos   === '3Mbps' &&
      isUnlim(p.voice),
  },
  {
    key:   'cond2',
    label: '15GB+3Mbps/100분',
    match: p =>
      p.data  && p.data.match(/^15GB($|\+)/) &&
      p.qos   === '3Mbps' &&
      p.voice && String(p.voice).includes('100'),
  },
  {
    key:   'cond3',
    label: '7GB+1Mbps/통화무제한',
    match: p =>
      p.data  && p.data.match(/^7GB($|\+)/) &&
      p.qos   === '1Mbps' &&
      isUnlim(p.voice),
  },
];

const NETS = ['SKT', 'KT', 'LG'];

// ─── 날짜 유틸 ───────────────────────────────────────────────────────────────
function today() {
  return new Date();
}
function isoDate(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
/** 최근 N개월 레이블 생성 (현재달 포함) */
function recentMonths(n = 4) {
  const months = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push({
      label: `${t.getMonth()+1}월`,
      sub:   `월초(${t.getMonth()+1}/1)`,
      isCurrent: i === 0,
    });
  }
  return months;
}

// ─── 데이터 추출 ─────────────────────────────────────────────────────────────
function extractData(plans) {
  // { company → { condKey → { net → { promo, period, after } } } }
  const result = {};

  const operators = [...new Set(plans.map(p => p.company))];

  for (const op of operators) {
    result[op] = {};
    const opPlans = plans.filter(p => p.company === op);

    for (const cond of CONDITIONS) {
      result[op][cond.key] = {};
      const matched = opPlans.filter(cond.match);

      for (const net of NETS) {
        const byNet = matched
          .filter(p => normCarrier(p.carrier) === net)
          .filter(p => p.curr_fee != null)
          .sort((a, b) => a.curr_fee - b.curr_fee);

        if (!byNet.length) {
          result[op][cond.key][net] = null;
          continue;
        }
        const best = byNet[0];
        result[op][cond.key][net] = {
          promo:  best.curr_fee,
          period: best.discount_period || '',
          after:  best.price_after_discount ?? null,
        };
      }
    }
  }
  return { operators, result };
}

// ─── Excel 생성 ──────────────────────────────────────────────────────────────
const HEADER_BLUE  = 'FF4472C4';
const HEADER_LIGHT = 'FF8DB4E2';
const COL_HEADER   = 'FFDCE6F1';
const YELLOW_FILL  = 'FFFFE699';

const thin = { style: 'thin', color: { argb: 'FF000000' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const center = { horizontal: 'center', vertical: 'middle' };

const OPERATOR_COLORS = [
  'FFFFF2CC','FFE2EFDA','FFDDEBF7','FFFCE4D6',
  'FFEDEDED','FFF4B8C1','FFE8D5F5','FFD9F0E8',
  'FFFFF9E6','FFE6F0FF','FFE0E0E0',
];

async function buildExcel(operators, result) {
  const MONTHS = recentMonths(4);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('중소사업자 비교');

  // ── 열 너비 ──
  ws.getColumn(1).width = 13;  // 사업자
  ws.getColumn(2).width = 20;  // 요금제
  ws.getColumn(3).width = 6;   // 통신망
  let col = 4;
  for (const m of MONTHS) {
    ws.getColumn(col).width   = 11;  // 프로모션요금
    ws.getColumn(col+1).width = 8;   // 기간
    ws.getColumn(col+2).width = 11;  // 종료 후
    col += 3;
  }

  // ── 헤더 Row 1: 사업자/요금제/통신망 + 월 ──
  const hFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BLUE  } };
  const hFont  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const shFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_LIGHT } };
  const shFont = { bold: true, size: 10 };
  const cFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COL_HEADER  } };

  function hCell(r, c, val, fill, font) {
    const cell = ws.getCell(r, c);
    cell.value = val; cell.fill = fill; cell.font = font;
    cell.alignment = center; cell.border = border;
    return cell;
  }

  ['사업자','요금제','통신망'].forEach((v, i) => hCell(1, i+1, v, hFill, hFont));
  ws.mergeCells('A1:A3'); ws.mergeCells('B1:B3'); ws.mergeCells('C1:C3');

  col = 4;
  for (const m of MONTHS) {
    hCell(1, col, m.label, hFill, hFont);
    ws.mergeCells(1, col, 1, col+2);
    hCell(2, col, m.sub, shFill, shFont);
    ws.mergeCells(2, col, 2, col+2);
    ['프로모션요금','기간','종료 후'].forEach((v, i) => hCell(3, col+i, v, cFill, shFont));
    col += 3;
  }

  ws.getRow(1).height = 20;
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 18;

  // ── 데이터 행 ──
  let rowIdx = 4;
  const currentMonthIdx = MONTHS.findIndex(m => m.isCurrent);

  operators.forEach((op, opIdx) => {
    const opStartRow = rowIdx;
    const opFill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: OPERATOR_COLORS[opIdx % OPERATOR_COLORS.length] },
    };

    CONDITIONS.forEach((cond, condIdx) => {
      const planStartRow = rowIdx;

      NETS.forEach(net => {
        ws.getRow(rowIdx).height = 16;

        // 통신망 셀
        const netCell = ws.getCell(rowIdx, 3);
        netCell.value = net; netCell.font = { size: 10 };
        netCell.alignment = center; netCell.border = border; netCell.fill = opFill;

        // 모든 월 셀 초기화 (흰 배경)
        for (let c = 4; c <= 4 + MONTHS.length * 3 - 1; c++) {
          const cell = ws.getCell(rowIdx, c);
          cell.font = { size: 10 }; cell.alignment = center; cell.border = border;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        }

        // 현재 월 데이터 채우기 (노란 배경)
        const d = result[op]?.[cond.key]?.[net];
        if (d) {
          const baseCol = 4 + currentMonthIdx * 3;
          const promoCell = ws.getCell(rowIdx, baseCol);
          promoCell.value = d.promo; promoCell.numFmt = '#,##0';
          promoCell.alignment = { horizontal: 'right', vertical: 'middle' };
          promoCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW_FILL } };
          promoCell.border = border; promoCell.font = { size: 10 };

          const periodCell = ws.getCell(rowIdx, baseCol+1);
          periodCell.value = d.period; periodCell.alignment = center;
          periodCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW_FILL } };
          periodCell.border = border; periodCell.font = { size: 10 };

          const afterCell = ws.getCell(rowIdx, baseCol+2);
          afterCell.value = d.after; afterCell.numFmt = '#,##0';
          afterCell.alignment = { horizontal: 'right', vertical: 'middle' };
          afterCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW_FILL } };
          afterCell.border = border; afterCell.font = { size: 10 };
        }

        rowIdx++;
      });

      // 요금제 병합
      ws.mergeCells(planStartRow, 2, rowIdx-1, 2);
      const planCell = ws.getCell(planStartRow, 2);
      planCell.value = cond.label; planCell.font = { bold: true, size: 9 };
      planCell.alignment = { ...center, wrapText: true }; planCell.border = border;
      planCell.fill = opFill;
    });

    // 사업자 병합
    ws.mergeCells(opStartRow, 1, rowIdx-1, 1);
    const opCell = ws.getCell(opStartRow, 1);
    opCell.value = op; opCell.font = { bold: true, size: 10 };
    opCell.alignment = center; opCell.border = border; opCell.fill = opFill;
  });

  const filename = `중소사업자_요금제비교_${isoDate()}.xlsx`;
  const outPath = path.join(OUT_DIR, filename);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('데이터 파일 없음. 먼저 npm run small 실행 필요:', DATA_FILE);
    process.exit(1);
  }

  const plans = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`데이터 로드: ${plans.length}건`);

  const { operators, result } = extractData(plans);
  console.log(`사업자: ${operators.join(', ')}`);

  // 조건별 결과 콘솔 출력
  for (const cond of CONDITIONS) {
    console.log(`\n[${cond.label}]`);
    for (const op of operators) {
      for (const net of NETS) {
        const d = result[op]?.[cond.key]?.[net];
        if (d) console.log(`  ${op} ${net}: ${d.promo?.toLocaleString()}원 / ${d.period} → ${d.after?.toLocaleString() ?? '-'}원`);
      }
    }
  }

  const outPath = await buildExcel(operators, result);
  console.log('\n저장 완료:', outPath);
})();
