# 人生 ERP iPhone Web App — v1

這是第一版可執行的前端原型，包含人生總覽、任務、目標、專案、財務、習慣六個頁面。資料先存於瀏覽器 `localStorage`，也可在完成 Google OAuth 設定後，將一份 `LifeERP-data.json` 存到使用者自己的 Google Drive。

## 架構選擇

- **前端**：原生 HTML / CSS / JavaScript，無需建置工具。
- **網頁託管**：建議 GitHub Pages（免費靜態網站）或其他 HTTPS 靜態網站託管。
- **雲端資料**：Google Drive API `drive.file` scope；應用程式只要求存取它自己建立／由使用者選擇提供給應用程式的檔案，不要求整個雲端硬碟的完整存取權。
- **不自架伺服器**：前端在瀏覽器運作，資料檔放在 Google Drive；OAuth 由 Google Identity Services 處理。

> 重要：程式目前是 v1 原型。請先測試，勿將唯一重要資料只放在尚未驗證的同步功能中。多裝置同時編輯目前採用簡單的「本機／雲端擇一」策略，還沒有衝突合併、版本歷史或多人協作。

## 先在電腦完成一次 Google 設定

Google OAuth 的初次設定通常需要在電腦瀏覽器完成；之後 iPhone 就能使用同一個網站。

1. 開啟 Google Cloud Console：<https://console.cloud.google.com/>
2. 建立一個專案，啟用 **Google Drive API**。
3. 在 Google Auth Platform 設定 OAuth 同意畫面。若選外部（External）且狀態為測試，請把自己的 Google 帳號加到 Test users。
4. 建立 OAuth Client ID，應用程式類型選 **Web application**。
5. 在 Authorized JavaScript origins 加入部署網站的完整來源，例如 `https://你的帳號.github.io`。不要填路徑，不要使用 `file://` 或 `localhost` 作為正式網站來源。
6. 複製 Client ID，打開 `app.js`，將 `CONFIG.googleClientId` 的 `PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com` 換成你的 Client ID。
7. 將此資料夾部署至 HTTPS 靜態網站。GitHub Pages 可從 repository 的 Settings → Pages 設定發布來源。
8. 用 iPhone Safari 開啟網站，點「連結 Google Drive」並授權。第一次同步會在 Drive 建立 `LifeERP-data.json`；之後可按「同步資料」。

Google 設定介面可能隨版本調整，請依 Cloud Console 的最新提示完成 OAuth 設定。Client ID 不是 client secret；不要將任何 OAuth client secret 放進前端程式碼。

## iPhone 加到主畫面

在 Safari 開啟已部署網站 → 分享 → **加入主畫面**。本專案提供 Web App manifest 與 service worker，支援基本快取；雲端同步仍需網路連線。

## 目前功能

- 新增、完成、刪除任務；依狀態篩選與搜尋。
- 新增目標／專案，手動增加進度。
- 記錄收入與支出，計算本月合計。
- 建立習慣並記錄今天是否完成。
- 本機自動儲存；Google Drive 手動同步 JSON 檔。

## 下一步建議

1. 實際測試 Drive OAuth、建立檔案、更新檔案與第二台裝置載入。
2. 加入明確的「從雲端載入」按鈕與同步衝突提示。
3. 加入匯出備份、資料驗證、編輯既有項目與刪除復原。
4. 再依使用情況拆分模組、做跨裝置衝突合併。

## 資料安全

財務資料可能相當敏感。使用個人 Google 帳號、妥善保護裝置與帳號，並定期下載備份。若要記錄密碼、身分證字號、銀行登入資訊等高度敏感資料，請不要存入此原型。