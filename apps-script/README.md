# error-FA — Apps Script 後端

這個資料夾是 error-FA 物料異常溝通看板的後端原始碼，用 `clasp` 推上 Google Apps Script。
前端（GitHub Pages 靜態站）在 repo 其他地方，兩邊靠 HTTP 溝通，彼此不共用程式碼。

## 檔案

| 檔案 | 內容 |
|---|---|
| `appsscript.json` | 專案設定：時區、V8 runtime、Web App 部署設定、OAuth scopes |
| `Code.gs` | `doPost`/`doGet` 路由、action 對照表、回應信封、`meta.bootstrap` |
| `Auth.gs` | 驗 Google ID token、Session 簽發與驗證、角色判定 |
| `Sheets.gs` | Sheets 存取層（表頭驅動的讀寫） |
| `Cases.gs` | 案件 CRUD、狀態變更、統計 |
| `Comments.gs` | 留言 CRUD（軟刪除） |
| `Files.gs` | 附件上傳／縮圖／刪除（Drive） |
| `Notify.gs` | Email 通知（新單／新留言／狀態變更） |
| `Setup.gs` | 一鍵建表、選單、排程設定 |

---

## 1. 建立 Apps Script 專案

兩種都可以，這個工具建議用「獨立專案」（不綁在 Sheets 檔案裡），管理比較清楚：

```bash
npm install -g @google/clasp     # 或每次都用 npx --yes @google/clasp
clasp login
clasp create --type standalone --title "error-FA" --rootDir ./apps-script
```

> **兩個一定會踩到的坑（實際跑過確認）：**
>
> 1. `--type webapp` 在 clasp 3.x 會回 `Invalid container file type`。
>    3.x 的 `--type` 只吃容器類型（sheets/docs/…）與 `standalone`，
>    「網頁應用程式」是**部署**時才決定的事，不是建立專案時。用 `standalone` 就對了。
> 2. 第一次用 clasp 會回 `User has not enabled the Apps Script API`。
>    到 https://script.google.com/home/usersettings 把開關打開，等一分鐘再重跑。

如果偏好綁定在試算表裡（開 Sheets → 擴充功能 → Apps Script），
也可以先在 Sheets 裡建立綁定專案，再用 `clasp clone <scriptId>` 把 scriptId 接到這個資料夾。

`.clasp.json`（`clasp create` 會自動產生，**不要 commit 進 repo**，裡面是這支 script 的 ID）：

```json
{ "scriptId": "你的 script id", "rootDir": "./apps-script" }
```

## 2. clasp 工作流程

```bash
cd apps-script
clasp push           # 把本機檔案推上 Apps Script（會整批覆蓋雲端程式碼，以本機為準）
clasp open-script    # 在瀏覽器開啟 Apps Script 編輯器，方便手動測試 / 看 log
clasp deploy -i <DEPLOYMENT_ID> -d "說明文字"   # 更新既有部署（見下方「部署地雷」，一定要帶 -i）
```

> 指令名稱以 clasp 3.x 為準（本專案用 3.3.0 驗過）。
> clasp 2.x 的 `clasp open` 在 3.x 改名為 `open-script`，其餘指令相同。

平常開發：改本機檔案 → `clasp push` → 在編輯器裡執行 `setupSheets()` 或個別函式測試 → 沒問題再 `clasp deploy -i`。
`clasp push` 只更新程式碼，**不會**更新 `/exec` 網址對外行為，那是 `clasp deploy` 的事——這正是下面地雷的成因。

## 3. Script Properties（機密與環境設定，不寫進程式碼）

Apps Script 編輯器 → 專案設定 → Script Properties，或用 clasp：

```bash
clasp run  # 或直接在編輯器的「專案設定」頁籤手動加
```

| Key | Value | 說明 |
|---|---|---|
| `CLIENT_ID` | `xxxxx.apps.googleusercontent.com` | 見下方第 5 節申請的 OAuth Client ID |
| `SPREADSHEET_ID` | 試算表網址中 `/d/` 和 `/edit` 中間那段 | 存六個分頁的那本 Sheets |

`Code.gs` 頂端也有同名常數 `CLIENT_ID` / `SPREADSHEET_ID` 當作 fallback——
沒設定 Script Properties 時會用常數；**正式環境請一律用 Script Properties**，
這樣機密／環境值不會進 git 歷史紀錄，換試算表或 OAuth Client 也不用改程式碼重新部署。

## 4. 部署為 Web App

Apps Script 編輯器 → 右上「部署」→「新增部署作業」（第一次）或「管理部署作業」（之後更新）：

- **類型**：網頁應用程式
- **執行身分（Execute as）**：**我**（也就是部署帳號自己，`appsscript.json` 裡對應 `executeAs: USER_DEPLOYING`）
- **誰可以存取（Who has access）**：**任何人（Anyone）**

### 為什麼一定要選「任何人」

這是整個架構裡最容易選錯、也最容易讓人想「改成 ecoco.xyz 網域比較安全」的地方——**千萬不要改**：

- 選「Anyone with Google Account」或「僅限本機構」都會讓 `/exec` 的回應變成先導向 Google 登入頁，
  瀏覽器端的跨網域 `fetch()` 對這種回應一定失敗（不是 CORS 錯誤，是整個 request 對不上預期格式）。
- 身分驗證**不是**靠 GAS 的存取設定做的，是靠這支程式自己驗 Google ID token（`Auth.gs` 的
  `verifyIdToken`）＋ 網域檢查（`hd === 'ecoco.xyz'`）＋ Session token。選「任何人」只是讓
  **匿名的 HTTP 請求進得來**，進來之後沒有合法 session token 一樣什麼都做不了（回
  `UNAUTHENTICATED`）。
- `ContentService` 沒辦法自己加 CORS header；能跨網域是因為 GAS 最終回應會先 302 導到
  `script.googleusercontent.com`，那個回應本身帶 `Access-Control-Allow-Origin: *`，瀏覽器的
  `fetch()` 預設會自動跟隨這個轉址，不用額外處理。前端發請求時 `Content-Type` 要用
  `text/plain;charset=utf-8`（讓它是 simple request，不觸發 preflight——GAS 不會處理 OPTIONS）。

### 部署地雷：deployment id 一定要固定

**`clasp deploy`（不帶 `-i`）每次都會建立一個全新的部署，配一個全新的 `/exec` 網址**，
前端 `config.js` 裡寫死的網址就會瞬間失效，而且不會有任何錯誤訊息——只是所有請求開始 404 或連不到。

正確流程：

1. 第一次部署（`clasp deploy` 不帶 `-i` 或用編輯器介面）之後，記下輸出的 **deployment id**
   （長得像 `AKfycb...`），把它寫在這裡：

   ```
   DEPLOYMENT_ID = <部署後把 id 貼在這裡，之後每次更新都要用這個>
   ```

2. 之後**每一次**更新都要帶 `-i`：

   ```bash
   clasp deploy -i <上面那個 DEPLOYMENT_ID> -d "2026-08-17 修正 xxx"
   ```

3. `Code.gs` 頂端的 `SCRIPT_VERSION` 常數，每次部署前手動 +1（或改成日期字串）。
   `doGet` 會回傳 `{ ok:true, data:{ service:'error-FA', version:SCRIPT_VERSION } }`——
   部署完直接瀏覽器開 `/exec` 網址，version 對不上預期值，就代表部署錯了 deployment 或忘記帶 `-i`。

## 5. Google Cloud Console — OAuth Client ID

1. [Google Cloud Console](https://console.cloud.google.com/) → 選一個專案（跟 Workspace 網域相關的專案）
   → API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID
2. 應用程式類型：**網頁應用程式**
3. **Authorized JavaScript origins** 加入：
   ```
   https://syji-gh.github.io
   ```
   （不要加路徑，只到網域；本機測試要另外加 `http://localhost:xxxx`）
4. 不需要 Authorized redirect URIs（前端用 Google Identity Services 的
   `google.accounts.id.initialize`，是 token flow 不是 redirect flow）
5. 建立後拿到的 Client ID（`xxxxx.apps.googleusercontent.com`）：
   - 前端 `assets/config.js` 填一份（本來就設計成公開值，寫進前端程式碼沒關係）
   - 後端 Script Properties 的 `CLIENT_ID` 也填同一份（`Auth.gs` 驗 token 時要核對 `aud`）
6. OAuth 同意畫面設定「使用者類型」建議選「內部」（Internal）——這樣只有 ecoco.xyz
   網域帳號看得到這支 App，多一層保險（後端的 `hd` 檢查是真正的把關，這只是錦上添花）。

## 6. 每日清理過期 Session

`Auth.gs` 的 session 記錄同時存在 CacheService（6 小時就沒了）和 Script Properties（12 小時到期，
但**不會自動被刪除**）。Script Properties 總容量上限 500KB，長期不清會慢慢塞滿。

設定方式（擇一）：

- 開試算表 → 選單「error-FA」→「設定每日清理排程（Session）」，會自動建立一個
  每天凌晨 3 點執行 `purgeExpiredSessions` 的時間觸發器（`ScriptApp` trigger），且**可重複點擊**
  （已存在就不會重複建立）。
- 或在 Apps Script 編輯器手動加：觸發條件 → 新增觸發條件 → 函式選 `purgeExpiredSessions` →
  事件來源「時間驅動」→ 「日計時器」。

## 7. 附件大小上限——這是實測值，不是官方保證的數字

| 類型 | 上限 | 理由 |
|---|---|---|
| 圖片（`mimeType` 開頭 `image/`） | 10MB | 前端已壓縮到長邊 ≤1600px、JPEG q0.8，實際檔案通常 <800KB，10MB 留很大安全邊際 |
| 其他檔案 | 5MB | Apps Script 單次 POST body 用 base64 夾帶檔案，可靠的單次上限大約落在 5MB base64 左右，**這是觀察到的行為，Google 沒有正式文件保證這個數字**；上線後如果發現更大檔案能穩定通過，可以放寬 `Files.gs` 的 `MAX_FILE_BYTES`，但建議先用實際檔案測試過再調整 |

超過上限會回 `BAD_REQUEST`，訊息裡會寫實際的上限（10MB / 5MB），前端可以直接顯示。

## 8. 初始化資料

1. 部署完成、Script Properties 填好之後，開對應的 Google Sheets（`SPREADSHEET_ID` 那本）
2. 重新整理頁面，會看到選單「error-FA」→「初始化工作表」，點下去會建立六個分頁
   （`Cases` / `Comments` / `Attachments` / `History` / `Members` / `Config`）並套用表頭樣式
3. 這個函式**可以重複執行**，不會清掉已經存在的資料，只會補回表頭／格式，也只在
   `Config` 裡某個 key 還沒有值時才寫入預設值
4. 手動去 `Config` 分頁把下面幾個值填好：
   - `driveRootFolderId`：附件要存的 Drive 資料夾 ID（建議用共用雲端硬碟，不要綁個人帳號）
   - `facilityGroupEmail`：廠務部群組信箱
5. `Members` 分頁手動加入廠務部成員（`role=facility`、`notify=TRUE`）；
   其他 ecoco.xyz 使用者第一次用 `session.login` 登入時會**自動**被加進 `Members`
   （`role=staff`、`active=TRUE`），不用手動維護每一個人。

---

## 給前端 `api.js` 的重點提醒

- 請求信封：`{ action, token, requestId, payload }`；`token` 是 `session.login` 換回來的
  session token，**不是** Google ID token；`requestId` 建議每次寫入類 action 都帶一個新的 UUID
  （冪等保護，600 秒內同一個 requestId 重送會拿到原本那次的結果，不會重複執行）。
- `ping` 和 `session.login` 是唯二不需要 `token` 的 action。
- Session 效期 12 小時；`token` 失效時任何 action 都會回
  `{ ok:false, error:{ code:'UNAUTHENTICATED', ... } }`，前端收到就導回登入畫面重新
  `session.login`。
- Content-Type 一定要用 `text/plain;charset=utf-8`（見第 4 節「為什麼一定要選任何人」）。
