/**
 * 일간 요금제 모니터링 이메일 발송
 * - 변동사항(GAP, NEW, 비노출)만 본문에 요약
 * - Excel 파일 첨부
 *
 * 환경변수:
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / EMAIL_TO
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../output');

function fmt(num) {
  if (num == null) return '-';
  return Number(num).toLocaleString('ko-KR') + '원';
}

function gapStr(gap) {
  if (typeof gap !== 'number') return String(gap);
  return gap > 0 ? `+${gap.toLocaleString()}원 ▲` : `${gap.toLocaleString()}원 ▼`;
}

function buildBody(meta) {
  const { totalToday, summary } = meta;
  const dateStr   = meta.todayDateStr || meta.dateStr;
  const prevLabel  = meta.prevLabel  || '전일';
  const todayLabel = meta.todayLabel || '당일';
  const hasChanges = summary.newCount + summary.hiddenCount + summary.changedCount > 0;

  const ymd = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;

  let body = `<html><head><meta charset="utf-8"><style>
    body { font-family: 'Malgun Gothic', sans-serif; font-size: 13px; color: #222; }
    h2 { color: #1a56db; border-bottom: 2px solid #1a56db; padding-bottom: 6px; }
    h3 { margin-top: 20px; margin-bottom: 6px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    th { background: #4472C4; color: #fff; padding: 6px 10px; text-align: left; }
    td { padding: 5px 10px; border-bottom: 1px solid #e0e0e0; }
    tr:nth-child(even) td { background: #f8f8f8; }
    .new    { color: #0070C0; font-weight: bold; }
    .hidden { color: #888; font-style: italic; }
    .up     { color: #cc0000; font-weight: bold; }
    .down   { color: #007700; font-weight: bold; }
    .none   { color: #555; }
    .summary-box { background: #f0f4ff; border-left: 4px solid #4472C4;
                   padding: 10px 16px; margin-bottom: 20px; border-radius: 4px; }
  </style></head><body>`;

  body += `<h2>📊 요금제 모니터링 일간 리포트 (${ymd})</h2>`;

  // 전체 요약 박스
  body += `<div class="summary-box">
    <strong>수집 현황</strong>: 총 <b>${totalToday.toLocaleString()}</b>개 요금제<br>
    신규 <b class="new">${summary.newCount}</b>건 &nbsp;|&nbsp;
    비노출 <b class="hidden">${summary.hiddenCount}</b>건 &nbsp;|&nbsp;
    가격변동 <b>${summary.changedCount}</b>건
  </div>`;

  if (!hasChanges) {
    body += `<p class="none">✅ 오늘은 변동된 요금제가 없습니다.</p>`;
  }

  // 신규 요금제
  if (summary.newCount > 0) {
    body += `<h3 class="new">🆕 신규 요금제 (${summary.newCount}건)</h3><table>
      <tr><th>회사명</th><th>기술방식</th><th>요금제명</th><th>데이터</th><th>QOS</th><th>당일가격</th></tr>`;
    for (const p of summary.newPlans) {
      body += `<tr>
        <td>${p.operator}</td>
        <td>${p.network_type}</td>
        <td class="new">${p.plan_name}</td>
        <td>${p.data ?? ''}</td>
        <td>${p.qos ?? '-'}</td>
        <td>${fmt(p['당일'])}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  // 비노출 요금제
  if (summary.hiddenCount > 0) {
    body += `<h3 class="hidden">🚫 비노출 요금제 (${summary.hiddenCount}건)</h3><table>
      <tr><th>회사명</th><th>기술방식</th><th>요금제명</th><th>전일가격</th></tr>`;
    for (const p of summary.hiddenPlans) {
      body += `<tr class="hidden">
        <td>${p.operator}</td>
        <td>${p.network_type}</td>
        <td>${p.plan_name}</td>
        <td>${fmt(p['전일'])}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  // 가격 변동 요금제
  if (summary.changedCount > 0) {
    body += `<h3>💰 가격 변동 요금제 (${summary.changedCount}건)</h3><table>
      <tr><th>회사명</th><th>요금제명</th><th>${prevLabel}</th><th>${todayLabel}</th><th>GAP</th></tr>`;
    for (const p of summary.changedPlans) {
      const cls = p.gap > 0 ? 'up' : 'down';
      body += `<tr>
        <td>${p.operator}</td>
        <td>${p.plan_name}</td>
        <td>${fmt(p['전일'])}</td>
        <td>${fmt(p['당일'])}</td>
        <td class="${cls}">${gapStr(p.gap)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  body += `<p style="color:#aaa;font-size:11px;margin-top:30px;">
    * 전일 대비 비교 기준: 혜택가(프로모션) 우선, 없을 경우 기본료<br>
    * 자세한 내용은 첨부 Excel 파일을 확인하세요.
  </p></body></html>`;

  return body;
}

async function sendMail(meta) {
  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_TO,
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
    throw new Error('이메일 환경변수 미설정: SMTP_HOST / SMTP_USER / SMTP_PASS / EMAIL_TO');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587'),
    secure: parseInt(SMTP_PORT || '587') === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const ds  = meta.todayDateStr || meta.dateStr;
  const ymd = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
  const hasChanges = meta.summary.newCount + meta.summary.hiddenCount + meta.summary.changedCount > 0;
  const subject = hasChanges
    ? `[요금제 모니터링] ${ymd} - 변동 ${meta.summary.newCount + meta.summary.hiddenCount + meta.summary.changedCount}건`
    : `[요금제 모니터링] ${ymd} - 변동 없음`;

  const html = buildBody(meta);

  // Excel 첨부
  const excelExists = fs.existsSync(meta.excelPath);
  const attachments = excelExists ? [{
    filename: path.basename(meta.excelPath),
    path: meta.excelPath,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }] : [];

  const info = await transporter.sendMail({
    from: `"요금제 모니터링" <${SMTP_USER}>`,
    to: EMAIL_TO,
    subject,
    html,
    attachments,
  });

  console.log(`메일 발송 완료: ${info.messageId} → ${EMAIL_TO}`);
  return info;
}

async function main() {
  const metaPath = path.join(OUTPUT_DIR, 'report_meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error('report_meta.json 없음. 먼저 report.js를 실행하세요.');
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  await sendMail(meta);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { sendMail, buildBody };
