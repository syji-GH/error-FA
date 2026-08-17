/**
 * error-FA 前端設定
 *
 * 這個檔案裡的值都是「本來就會公開」的識別碼，不是密鑰：
 *   - CLIENT_ID：OAuth Web Client ID，設計上就是放在前端的公開值
 *   - GAS_URL  ：後端入口，任何請求都要通過 ID token + ecoco.xyz 網域驗證才拿得到資料
 * 真正的把關全部在 Apps Script 端。
 */
window.CONFIG = {
  // Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)
  // Authorized JavaScript origins 需加入 https://syji-gh.github.io
  CLIENT_ID: 'REPLACE_ME.apps.googleusercontent.com',

  // Apps Script 部署後的 /exec 網址（Execute as: Me、Who has access: Anyone）
  GAS_URL: 'REPLACE_ME',

  // 只是提示 Google 預選公司帳號用；真正的網域限制在後端 verifyIdToken() 做
  HD: 'ecoco.xyz',

  // 線上試算表連結（選單「開啟線上試算表」用）
  SHEET_URL: '',
};

/* ── 常數：需與 Apps Script 端一致 ───────────────────────────── */

window.CASE_TYPES = ['需追加採購', '廠商送錯', '料號變更', '物料異常', '其他'];

window.STATUSES = ['待處理', '處理中', '暫緩', '已結案'];

// 狀態配色（依 ECOCO_DESIGN.md，不用 Tailwind 預設藍/橘）
window.STATUS_STYLE = {
  '待處理': { dot: '#FFCE00', chip: 'bg-[#FFF8DB] text-[#8A6D00] border-[#FFE9A3]' },
  '處理中': { dot: '#FF5000', chip: 'bg-orange-50 text-ecoco-orange border-orange-200' },
  '暫緩':   { dot: '#6B7280', chip: 'bg-card text-muted border-line' },
  '已結案': { dot: '#22C55E', chip: 'bg-green-50 text-green-700 border-green-200' },
};

window.TYPE_CHIP = 'bg-card text-ecoco-blue border-line';
