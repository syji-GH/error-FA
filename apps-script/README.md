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
| `Repair.gs` | 案號撞號的診斷與修復（一次性維護工具，不對外開 action） |

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
   確認版本要用 **POST `ping`**，不要用瀏覽器直接開 `/exec`：

   ```bash
   curl -sL -H "Content-Type: text/plain;charset=utf-8" -d '{"action":"ping"}' <EXEC_URL>
   # → {"ok":true,"data":{"pong":true,"now":"...","version":"2026-08-18.2"}}
   ```

   **Google 會快取 `/exec` 的 GET 回應**，實測即使加上 `?t=<timestamp>` 或
   `Cache-Control: no-cache` 也一樣回舊版本號，所以 `doGet` 不能拿來判斷部署是否生效
   （這點是實際踩過才發現的——`doGet` 回舊值但 POST 回新值）。
   `doGet` 現在只留著當「服務有沒有活著」的健康檢查。
   version 對不上預期值，代表部署錯了 deployment 或忘記帶 `-i`。

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

## 8. 案號撞號的檢查與修復

`cases.get` 走 `getRowById`，同一個案號在 Cases 分頁有兩列時**只會回第一列**——後開的那張單
在清單上看得到、點下去卻跳出前一張，等於整張單被蓋住。2026/09 實際發生過，
`FA-2026-0001` 到 `FA-2026-0005` 各被發了兩次。

**根本原因是 `Config` 的 `lastCaseSeq` 被 Sheets 吃掉。** 那格存的是 `"2026:10"` 這種字串，
Sheets 會把長得像 `h:mm` 的字串轉成時間值，而且**分鐘要兩位數才會觸發**——所以
`"2026:1"` 到 `"2026:9"` 都好好的是文字，一寫到 `"2026:10"` 就變成時距。讀回來是 Date、
被 `normalizeCell_` 轉成 ISO 字串，`nextCaseId_` 的年度比對失敗、流水號歸零，
案號就從 `FA-2026-0001` 重發一輪，跑到 10 再壞一次。

修了四個地方：

- `Sheets.gs` 的 `setConfig` 寫入前先把儲存格格式設成純文字（`@`），Sheets 不會再動它
- `Cases.gs` 的 `nextCaseId_` 不再只信計數器：`lastCaseSeq` 只當「下限提示」，
  真正的依據是 Cases 分頁本身已經用掉哪些號，計數器不管因為什麼理由倒退都不會發出重複的號
- 三處 `LockService` 的 `finally` 補上 `SpreadsheetApp.flush()`，避免寫入還沒落地就放鎖、
  被下一個請求讀到舊值
- `Sheets.gs` 的 `appendRow` / `updateRowById` 在寫值**之前**先把文字欄位鎖成純文字，
  同一類的坑（`=` 開頭變公式、前導零被吃掉、像日期的字串被轉型）一次擋掉

哪些欄位算「文字」列在 `Sheets.gs` 的 `TEXT_COLUMNS_`。只列真的必須是文字的欄位——
時間戳、`qty`、`size`、計數、布林值不在裡面，它們本來就該讓 Sheets 存成原生型別，
讀取端的 `normalizeCell_` 會處理。`appendRow` 不再用 `sh.appendRow()`，因為格式一定要在
寫值之前設好；Sheets 是在寫入的當下就猜型別的，寫完再補格式救不回來。

沒被這次處理到的是**既有列**：手動在試算表上改舊資料仍可能被轉型（欄位格式只在程式寫入
那一格時才鎖）。`Members` 分頁是唯一常手動編輯的，欄位都是 email / 姓名 / 部門 / 角色，
不會被誤判，所以先不動。

既有資料要靠 `Repair.gs` 補救。獨立專案沒有試算表選單，直接在 Apps Script 編輯器的函式下拉選單執行：

| 函式 | 作用 |
|---|---|
| `diagnoseDuplicateCaseIds()` | **唯讀**。列出撞號的案號、每一列的標題與建立時間，以及修復時打算怎麼搬留言／附件／歷程 |
| `repairDuplicateCaseIds()` | 實際修。組內最早建立的那張保留原案號，後開的重新配一個沒用過的號 |

子資料列的歸屬規則：時間最接近哪一列的 `createdAt` 就算誰的，但只在 5 分鐘內才算數，
其餘一律留給保留原號的那張。這樣分是因為被蓋住的那張單根本點不開，除了開單那一刻寫進去的
`create` 歷程與初始附件，之後的留言、附件、歷程一定都是使用者對「保留原號的那張」做的。

**先跑 `diagnoseDuplicateCaseIds()` 看一次搬移計畫再修**，改完 `commentCount` / `attachmentCount`
會一併重算，`lastCaseSeq` 也會往前推到目前用掉的最大號。Drive 上的附件資料夾仍叫舊案號，
附件是靠 `driveFileId` 開的，不影響顯示。

## 9. 資料健檢

`diagnoseDataIntegrity()`（唯讀，在 Apps Script 編輯器執行）把案號撞號的教訓一般化，
一次掃三件事：

| 檢查 | 為什麼 |
|---|---|
| 所有 id 欄位有沒有撞號 | `Cases.caseId`、`Comments.commentId`、`Attachments.attId`、`History.histId`、`Members.email`（不分大小寫）、`Config.key`。凡是拿某個欄位當 id 去撈一列的地方，撞號都會讓後面那筆安靜消失 |
| 文字欄位有沒有被 Sheets 轉型 | 列出 `TEXT_COLUMNS_` 裡實際存成數字或布林值的格子，就是被自動轉型吃掉的那些 |
| 子資料列有沒有指向不存在的案號 | 留言／附件／歷程掛在已經不存在的 `caseId` 上，畫面上永遠看不到 |

`Members.email` 重複時執行期不會壞掉：`Auth.gs` 的 `findMemberRow_` 會記一筆
`console.error`，並且優先採用還在啟用中的那一列——不然名單上面剛好留了一列停用的舊資料，
這個人就會被整個擋在門外而且看不出原因。但這只是止血，重複的列還是要在試算表上清掉。

## 10. 寫入的併發保護

`Code.gs` 的 `withWriteLock_` 包住所有「讀出來改一改再寫回去」的區塊：

- **一定要鎖**：`updateRowById` 是整列讀出、整列寫回，兩個請求同時動同一列的話，
  後寫的會把先寫的欄位整個蓋掉；`commentCount` 這種計數欄還必須在鎖裡重讀再加減，
  不能拿進鎖之前那份資料算
- **一定要 flush**：Apps Script 的試算表寫入是批次的，不 `SpreadsheetApp.flush()` 就放鎖，
  下一個請求進鎖後讀到的還是舊值——案號撞號就有這個成分在

`Comments.gs` 三個寫入路徑原本完全沒上鎖，已補上。`comments.create` 的附件上傳刻意留在鎖
外面：Drive 往返可能好幾秒，不該佔著全域鎖擋住其他人。

所有會寫入的路徑都走 `withWriteLock_`：`cases.create`（取案號）、`cases.update`、
`cases.setStatus`、`comments.create` / `update` / `delete`。不要再手寫一次鎖，
漏掉 `flush()` 或忘了在鎖裡重讀，錯法都是安靜的。

## 11. 初始化資料

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

## 12. 編輯案件與變更歷程

### 誰可以編輯：兩層權限

「單子寫了什麼」跟「單子處理到哪」是兩件事，所以權限分兩層（都在 `Auth.gs`）：

| 層 | 函式 | 誰 | 管什麼 |
|---|---|---|---|
| 內容 | `canEditCaseContent` | **開單人**、admin | `type` `title` `partNo` `partName` `vendor` `poNo` `qty` `unit` `needByDate` `description` + 案件附件 |
| 處理 | `canEditCase` | 開單人、**廠務部**、admin | `assignee` `resolution`（`canSetStatus` 也是這一層） |

**個人改個人的單** —— 廠務部可以接手處理別人的單、指派承辦人、填處理結果、改狀態，
但不能去改別人回報的事實（料號寫什麼、狀況說明寫什麼、附了哪些照片）。
要補充資訊或附照片，走留言，留言本來就人人可發。

admin 兩層都過：開單人離職或單子填錯時得有人能收尾。

`cases.get` 會回 `permissions: { canSetStatus, canEditCase, canEditContent }`，
前端據此決定「編輯」按鈕出不出現、Modal 裡長哪幾段。
兩層在後端是分開檢查的（`cases.update` 看這次 patch 碰到哪一組欄位），
把前端按鈕藏起來不算數。

### 可以改哪些欄位

`Cases.gs` 的 `CASE_CONTENT_FIELDS` 與 `CASE_HANDLING_FIELDS`，
合起來就是 `cases.update` 的欄位 allow-list。

`status` **兩組都不在** —— 狀態有自己的通知信，一律走 `cases.setStatus`，
從 `cases.update` 送 `status` 會被擋下並提示改用正確的 action。

必填規則（類型合法、「其他」以外要有料號、描述不可空）是拿**改完之後的樣子**驗的，
所以「只改類型」也會在讓料號變成必填時被擋下。

### 一次請求做完三件事

`cases.update` 的 payload 同時吃欄位、要加的附件、要移除的附件：

```json
{
  "caseId": "FA-2026-0007",
  "patch": { "partNo": "A-1024", "description": "..." },
  "addAttachments": [{ "fileName": "new.jpg", "mimeType": "image/jpeg", "dataBase64": "..." }],
  "removeAttachmentIds": ["A-xxxx"],
  "note": "廠商重拍了清楚的缺陷照片"
}
```

合併成一個 action 是因為 `/exec` 每趟往返固定 ~1.15 秒；換一張圖如果拆成
「改欄位 + 刪舊圖 + 傳新圖」三個請求，使用者要等三倍時間。

### 每一項變更都會寫進 History

| `action` | `fromValue` → `toValue` | `refId` |
|---|---|---|
| 欄位名（`partNo`、`description`…） | 舊值 → 新值（存全文，上限 20000 字） | 空 |
| `status` | 舊狀態 → 新狀態 | 空 |
| `attachment.add` | → 檔名 | 新附件的 `attId` |
| `attachment.remove` | 檔名 → | 被移除附件的 `attId` |

同一次 `cases.update` 產生的每一列共用同一個 `at`，前端就靠這個把它們併成一組顯示。
`note`（修改原因）會寫進該次的每一列。

### 附件是軟刪除，Drive 檔案刻意留著

移除附件只會把 `Attachments` 的 `isDeleted` / `deletedAt` / `deletedBy` 填上，
**不會**呼叫 `setTrashed(true)`。

這是刻意的：需求是「換過的圖要看得到舊的」，而 Drive 檔案一旦進垃圾桶，
縮圖與檢視連結會一起失效，歷程紀錄就只剩一行沒有圖的文字，等於沒留到。

代價是 Drive 空間不會因為移除附件而釋放。真的要清掉必須到 Drive 手動刪，
刪掉之後那筆歷程紀錄的縮圖就會變成「無法顯示」，其餘資訊（誰、何時、檔名）還在。

`cases.get` 因此回傳兩個陣列：`attachments`（現行）與 `removedAttachments`（已移除），
前端用後者把歷程裡的舊圖畫出來。列表頁的卡片縮圖只取現行的。

### 升級既有的試算表

這個功能替 `Attachments` 加了 `isDeleted` / `deletedAt` / `deletedBy` 三欄，
替 `History` 加了 `refId` 一欄，都接在原本欄位的**後面**。

部署新版程式之後**要再跑一次 `setupSheets()`**（選單「初始化工作表」或在編輯器直接執行）
把表頭補上去。舊資料列不用動：這些欄位讀出來是空字串，
`isAttachmentDeleted_()` 會當成「沒有被移除」，行為跟升級前一樣。


## 給前端 `api.js` 的重點提醒

- 請求信封：`{ action, token, requestId, payload }`；`token` 是 `session.login` 換回來的
  session token，**不是** Google ID token；`requestId` 建議每次寫入類 action 都帶一個新的 UUID
  （冪等保護，600 秒內同一個 requestId 重送會拿到原本那次的結果，不會重複執行）。
- `ping` 和 `session.login` 是唯二不需要 `token` 的 action。
- Session 效期 12 小時（絕對壽命，不會因為持續使用而延長）；前端另有一層閒置逾時，
  預設 60 分鐘沒操作就自動登出，見 `assets/config.js` 的 `IDLE_MINUTES`。
- `token` 失效時任何 action 都會回
  `{ ok:false, error:{ code:'UNAUTHENTICATED', ... } }`，前端收到就導回登入畫面重新
  `session.login`。
- Content-Type 一定要用 `text/plain;charset=utf-8`（見第 4 節「為什麼一定要選任何人」）。
