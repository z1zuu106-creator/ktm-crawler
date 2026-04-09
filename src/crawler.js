/**
 * KT M모바일 요금제 크롤러
 *
 * 수집 전략:
 *  1. getCtgXmlAllListAjax.do → 전체 카테고리 트리 조회
 *  2. relCnt > 0 인 카테고리 대상으로 rateContentAjax.do 호출
 *  3. 요금제별 필드 정규화 + QoS 추출
 *  4. plan_code 기준 중복 제거
 *  5. JSON + CSV 저장
 */

const { fetchCategories, fetchPlansByCategory } = require('./api');
const { parsePlan } = require('./parser');
const { saveJSON, saveCSV } = require('./output');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
const DELAY_MS = 300; // 요청 간 딜레이 (ms)

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'crawler.log'), line + '\n', 'utf8');
}

/**
 * 카테고리 맵 구성 (ctgCd → category)
 */
function buildCategoryMap(categories) {
  const map = {};
  categories.forEach(c => {
    map[c.rateAdsvcCtgCd] = c;
  });
  return map;
}

/**
 * 수집 대상 카테고리 필터링
 * - relCnt > 0: 실제 요금제가 있는 카테고리
 * - 제외: depthKey=1 루트 카테고리 (1,2,3)
 */
function getTargetCategories(categories) {
  return categories.filter(c => c.relCnt > 0);
}

/**
 * 메인 크롤링 로직
 */
async function crawl() {
  const startTime = Date.now();
  log('=== KT M모바일 요금제 크롤링 시작 ===');

  // 1. 카테고리 조회
  log('카테고리 목록 조회 중...');
  let categories;
  try {
    categories = await fetchCategories();
    log(`카테고리 ${categories.length}개 조회 완료`);
  } catch (err) {
    log(`카테고리 조회 실패: ${err.message}`);
    process.exit(1);
  }

  const categoryMap = buildCategoryMap(categories);
  const targetCategories = getTargetCategories(categories);
  log(`수집 대상 카테고리: ${targetCategories.length}개`);

  // 2. 요금제 수집
  const allPlans = [];
  const seenCodes = new Set();
  const failedCategories = [];

  for (const category of targetCategories) {
    const { rateAdsvcCtgCd, rateAdsvcCtgNm, relCnt } = category;
    log(`  카테고리 [${rateAdsvcCtgCd}] ${rateAdsvcCtgNm} (예상 ${relCnt}건) 수집 중...`);

    try {
      await sleep(DELAY_MS);
      const rawPlans = await fetchPlansByCategory(rateAdsvcCtgCd);

      if (!Array.isArray(rawPlans)) {
        log(`    ⚠ 응답이 배열이 아님: ${JSON.stringify(rawPlans).substring(0, 100)}`);
        continue;
      }

      let added = 0;
      let duped = 0;

      for (const rawPlan of rawPlans) {
        const planCode = rawPlan.rateAdsvcCd || rawPlan.rateAdsvcNm;
        if (!planCode) continue;

        // 중복 제거: plan_code 기준
        if (seenCodes.has(planCode)) {
          duped++;
          continue;
        }
        seenCodes.add(planCode);

        try {
          const parsed = parsePlan(rawPlan, category, categoryMap);
          allPlans.push(parsed);
          added++;
        } catch (parseErr) {
          log(`    ⚠ 파싱 오류 [${planCode}]: ${parseErr.message}`);
        }
      }

      log(`    ✓ ${added}건 추가 (중복 ${duped}건 제외), 응답 ${rawPlans.length}건`);

    } catch (err) {
      log(`    ✗ 실패 [${rateAdsvcCtgCd}]: ${err.message}`);
      failedCategories.push({ ctgCd: rateAdsvcCtgCd, name: rateAdsvcCtgNm, error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\n=== 수집 완료: ${allPlans.length}건 (총 ${elapsed}초) ===`);

  // 실패 기록
  if (failedCategories.length > 0) {
    const failPath = path.join(LOG_DIR, 'failed_categories.json');
    fs.writeFileSync(failPath, JSON.stringify(failedCategories, null, 2));
    log(`실패 카테고리 저장: ${failPath}`);
  }

  // 3. 결과 저장
  saveJSON(allPlans);
  await saveCSV(allPlans);

  // 4. 수집 요약 출력
  printSummary(allPlans);

  log('=== 크롤링 완료 ===');
  return allPlans;
}

function printSummary(plans) {
  const byNetwork = {};
  const byType = {};
  const withQoS = plans.filter(p => p.qos_speed !== null).length;
  const withBenefit = plans.filter(p => p.benefit_price !== null).length;
  const partnerships = plans.filter(p => p.partnership_flag).length;

  plans.forEach(p => {
    byNetwork[p.network_type] = (byNetwork[p.network_type] || 0) + 1;
    const t = p.plan_type.join(',');
    byType[t] = (byType[t] || 0) + 1;
  });

  log('\n--- 수집 요약 ---');
  log(`총 요금제: ${plans.length}건`);
  log(`QoS 있는 요금제: ${withQoS}건 (${Math.round(withQoS / plans.length * 100)}%)`);
  log(`혜택가 있는 요금제: ${withBenefit}건`);
  log(`제휴 요금제: ${partnerships}건`);
  log('네트워크별: ' + Object.entries(byNetwork).map(([k, v]) => `${k}=${v}`).join(', '));
  log('가입형태별: ' + Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', '));
}

// 직접 실행 시
if (require.main === module) {
  crawl().catch(err => {
    log(`크롤링 오류: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = { crawl };
