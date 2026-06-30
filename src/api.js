/**
 * KT M모바일 API 호출 모듈
 */

// KTM 서버가 자체 서명 인증서를 사용하므로 검증 비활성화
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://www.ktmmobile.com';
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.ktmmobile.com/rate/rateList.do',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://www.ktmmobile.com',
};

function rand() {
  return Math.floor(Math.random() * 1e10);
}

async function postForm(path, params) {
  const body = new URLSearchParams({ ...params, rand: rand() }).toString();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON parse error at ${path}: ${text.substring(0, 200)}`);
  }
}

/**
 * 전체 카테고리 목록 조회
 * @returns {Promise<Array>} 카테고리 배열
 */
async function fetchCategories() {
  return postForm('/rate/getCtgXmlAllListAjax.do', { rateAdsvcDivCd: 'RATE' });
}

/**
 * 카테고리별 요금제 목록 조회
 * @param {string} ctgCd 카테고리 코드
 * @returns {Promise<Array>} 요금제 배열
 */
async function fetchPlansByCategory(ctgCd) {
  return postForm('/rate/rateContentAjax.do', { rateAdsvcCtgCd: ctgCd });
}

module.exports = { fetchCategories, fetchPlansByCategory };
