/**
 * 결과 저장 모듈 (JSON + CSV)
 */

const fs = require('fs');
const path = require('path');
const { format } = require('@fast-csv/format');

const OUTPUT_DIR = path.join(__dirname, '../output');

/**
 * JSON 저장
 */
function saveJSON(plans, filename = 'ktm_plans.json') {
  const filepath = path.join(OUTPUT_DIR, filename);
  // 내부 참조 필드(_로 시작) 제거
  const clean = plans.map(p => {
    const out = { ...p };
    Object.keys(out).filter(k => k.startsWith('_')).forEach(k => delete out[k]);
    return out;
  });
  fs.writeFileSync(filepath, JSON.stringify(clean, null, 2), 'utf8');
  console.log(`JSON 저장: ${filepath} (${plans.length}건)`);
  return filepath;
}

/**
 * CSV 저장
 */
async function saveCSV(plans, filename = 'ktm_plans.csv') {
  return new Promise((resolve, reject) => {
    const filepath = path.join(OUTPUT_DIR, filename);
    const ws = fs.createWriteStream(filepath, { encoding: 'utf8' });

    const csvStream = format({
      headers: [
        'plan_name', 'plan_code',
        'data_allowance_raw', 'data_allowance_normalized',
        'qos_raw', 'qos_speed',
        'voice_allowance', 'sms_allowance',
        'base_price_text', 'base_price',
        'benefit_price_text', 'benefit_price',
        'plan_type', 'partnership_flag', 'network_type', 'product_group',
        'source_url', 'collected_at',
      ],
      writeBOM: true,  // Excel 한글 지원
    });

    csvStream.pipe(ws);

    plans.forEach(p => {
      csvStream.write({
        ...p,
        plan_type: Array.isArray(p.plan_type) ? p.plan_type.join(',') : p.plan_type,
      });
    });

    csvStream.end();
    ws.on('finish', () => {
      console.log(`CSV 저장: ${filepath} (${plans.length}건)`);
      resolve(filepath);
    });
    ws.on('error', reject);
  });
}

module.exports = { saveJSON, saveCSV };
