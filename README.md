# error-FA 物料異常看板

採購／資材 ⇄ 廠務部 的物料異常回報、討論與結案追蹤。

- **前端**：純 HTML/JS + Tailwind CDN，無建置步驟，放 GitHub Pages
- **後端**：Google Apps Script Web App（`apps-script/`）
- **資料**：Google Sheets（同時就是可以直接打開的「線上 Excel」）
- **附件**：Google Drive，每個案件一個子資料夾
- **登入**：公司 Google 帳號，限 `@ecoco.xyz`
- **通知**：新開單／新留言／狀態變更寄 Email

視覺規範一律依照 [`ECOCO_DESIGN.md`](ECOCO_DESIGN.md)。

---

## 架構

```
瀏覽器（GitHub Pages 靜態站）
  │  Google 登入 → ID token
  │  POST text/plain + JSON
  ▼
Apps Script Web App  ← 唯一後端：驗身分、驗網域、驗權限
  ├─ Google Sheets  資料庫
  ├─ Google Drive   附件
  └─ MailApp        通知信
```

GitHub Pages 只能放靜態檔，不能藏密鑰也不能驗身分，所以**所有權限判斷都在 Apps Script 端**。
前端只有兩個本來就公開的識別碼：OAuth Client ID 與 Web App URL。

---

## ⚠️ repo 必須是 public

GitHub 免費方案**無法**從 private repo 發布 GitHub Pages
（private repo 開 Pages 要 Pro/Team 以上；「站台本身設存取控制」更只有 Enterprise Cloud 才有）。

改成 public 是安全的 —— repo 裡沒有任何機密：

| 東西 | 位置 | 公開後的風險 |
|---|---|---|
| 前端程式碼 | repo | 無 |
| OAuth Client ID | `assets/config.js` | 無，設計上就是公開值 |
| Apps Script Web App URL | `assets/config.js` | 低：任何請求都要通過 ID token 與 `ecoco.xyz` 網域驗證 |
| 案件資料、附件、人員名單 | Google Sheets / Drive | 不在 repo 裡，由 Google 權限管控 |

若最後決定不能公開，備援作法是改用 Apps Script `HtmlService` 直接吐出整個 UI，
部署時選「僅限 ecoco.xyz 使用者」，就不需要 GitHub Pages —— 但會失去 git 部署流程。

---

## 建置步驟

照順序做，每一步都會用到上一步的產出。

### 1. Google 端資源

1. 在**共用雲端硬碟**（不要用個人 My Drive，避免綁在某個人的帳號上）建立資料夾
   `物料異常看板/`，裡面再建 `cases/`。
2. 在同一個資料夾建立試算表，命名 `ECOCO_物料異常看板_DB`。記下網址中的 spreadsheet ID。
3. 建立（或指定）廠務部的 Google 群組信箱，例如 `factory@ecoco.xyz`。
4. 建議用一個專屬帳號（例如 `fa-bot@ecoco.xyz`）來擁有這支 Apps Script：
   Workspace 帳號的寄信配額是 1,500 收件人／日，而且人員異動時系統不會跟著消失。

### 2. OAuth Client ID

Google Cloud Console → **APIs & Services → Credentials → Create Credentials →
OAuth client ID → Web application**

- **Authorized JavaScript origins** 填 `https://syji-gh.github.io`
  （只填 origin，**不要**帶 `/error-FA/` 路徑；本機測試再加 `http://localhost:8080`）
- 不需要 redirect URI，也不會用到 client secret

記下 Client ID。

### 3. 部署 Apps Script

詳見 [`apps-script/README.md`](apps-script/README.md)。重點：

- 部署時 **「誰可以存取」必須選「所有人」**。選「擁有 Google 帳戶的所有人」的話，
  跨網域請求會被導到 Google 登入頁而不是回 JSON，前端一定壞。
  身分是我們自己驗 ID token，不靠這個設定。
- 之後每次改版都要用**同一個 deployment ID** 重新部署，否則 `/exec` 網址會變、前端會斷。
- 在 Script Properties 填入 `GOOGLE_CLIENT_ID`、`ALLOWED_DOMAIN`、`SPREADSHEET_ID`、
  `DRIVE_ROOT_FOLDER_ID`、`FACTORY_GROUP_EMAIL`。
- 執行一次 `setupSheets()` 建立六個分頁與表頭。

### 4. 填前端設定

編輯 `assets/config.js`：

```js
CLIENT_ID: '你的 client id.apps.googleusercontent.com',
GAS_URL:   'https://script.google.com/macros/s/xxxxx/exec',
SHEET_URL: '試算表網址',
```

### 5. 開啟 GitHub Pages

Repo → **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**

站台網址：`https://syji-gh.github.io/error-FA/`

---

## 上線前的驗收清單

先做 **Phase 0**，這三項沒過就不要往下做 —— 整個架構的風險都集中在這裡：

- [ ] 從站台 Console 發一次 `fetch(GAS_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:'{"action":"ping"}'})`，
      拿到 JSON 而不是 CORS 錯誤
- [ ] 用 `@ecoco.xyz` 帳號登入 → 進得去，右上角顯示正確姓名與角色
- [ ] 用個人 `@gmail.com` 帳號登入 → 被擋下，顯示「請改用公司帳號」

接著：

- [ ] 開一張單 → `Cases` 分頁立刻多一列，欄位對得上
- [ ] 換另一個帳號留言 → `Comments` 多一列，畫面顯示正確姓名
- [ ] **用非廠務部、非開單人的帳號，直接在 Console 呼叫 `cases.setStatus` → 必須被擋**
      （權限是在後端擋，不是只把按鈕藏起來）
- [ ] 結案 → `Cases.status` 更新，`History` 多一列稽核紀錄
- [ ] 手機拍照上傳 → Drive 出現對應子資料夾，前端縮圖顯示正常
- [ ] 用外部帳號開附件連結 → 被 Google 擋下
- [ ] 開單後廠務部信箱收到通知信，點連結直達該案件
- [ ] 連續留言三則 → 只收到一封（5 分鐘去重生效）

---

## 前端檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 登入閘門 + app shell + Tailwind 品牌色設定 |
| `assets/config.js` | Client ID、Web App URL、狀態／類型常數 |
| `assets/auth.js` | Google 登入、session token、逾期重新登入 |
| `assets/api.js` | 與後端溝通的唯一入口（CORS 限制都寫在這裡的註解） |
| `assets/ui.js` | badge、modal、toast、頭像、時間格式等共用元件 |
| `assets/app.js` | 路由、列表頁、詳情頁、留言、開單、附件上傳 |
| `assets/styles.css` | Tailwind utility 蓋不掉的少數樣式 |

---

## 已知限制

- **圖片縮圖走 Drive 直連**，在「瀏覽器預設 Google 帳號不是 ecoco.xyz」的情況下可能載不出來。
  前端有 `onerror` 退路會改由後端代取，但會慢一點。
- **非圖片附件上限 5MB**。Apps Script 的 POST body 上限沒有官方文件，
  實測可靠範圍約 5MB base64；圖片因為前端會先壓縮，實際幾乎都在 1MB 以下。
- **Sheets 當資料庫**在資料量很大（上萬列）時列表會變慢，屆時可依年度分表。
- **無法做 IP 層級的流量限制** —— Apps Script 拿不到來源 IP，只能做「每個已登入帳號」的節流。
  未登入的請求會在最前面幾行就被擋掉，不會碰到 Sheets。
