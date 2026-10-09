/*
 * Life ERP Google Drive sync (Google Identity Services + Drive API v3)
 *
 * Setup:
 * 1. Set GOOGLE_CLIENT_ID below.
 * 2. Keep <script src="https://accounts.google.com/gsi/client" async defer></script>
 *    and this file loaded by index.html.
 * 3. This standalone starter stores the app payload under localStorage key
 *    "lifeErpData". See window.LifeERPSync.getData()/saveData() integration notes.
 *
 * Safety model: first connection always reads Drive before any upload. A missing
 * remote file on a device with local data requires explicit user choice. A
 * changed remote revision is never overwritten silently.
 */
(function () {
  "use strict";

  const GOOGLE_CLIENT_ID = "37043859391-oplvfbrqs2l0d74pn10o8bmt2ogfnkn0.apps.googleusercontent.com";
  const FILE_NAME = "LifeERP-data.json";
  const STORAGE_KEY = "lifeErpData";
  const STATE_KEY = "lifeErpDriveSyncState";
  const SCOPES = "https://www.googleapis.com/auth/drive.appdata";
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

  let tokenClient;
  let accessToken = null;
  let busy = false;

  function status(message, kind) {
    window.dispatchEvent(new CustomEvent("lifeerp:sync-status", {
      detail: { message, kind: kind || "info" }
    }));
    const node = document.querySelector("[data-lifeerp-sync-status]");
    if (node) node.textContent = message;
    const drive = document.querySelector("#driveStatus");
    if (drive) drive.innerHTML = '<span class="status-dot"></span><span>' + message + '</span>';
  }

  function readLocal() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { exists: false, value: null, raw: null };
    try {
      return { exists: true, value: JSON.parse(raw), raw };
    } catch (error) {
      throw new Error("本機資料格式無法解析；為避免覆蓋，已停止同步。請先備份或修復資料。");
    }
  }

  function writeLocal(value) {
    const raw = JSON.stringify(value, null, 2);
    localStorage.setItem(STORAGE_KEY, raw);
    return raw;
  }

  function getState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); }
    catch (_) { return {}; }
  }

  function setState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  function hash(text) {
    // Deterministic lightweight fingerprint for local change detection.
    let h1 = 0xdeadbeef ^ text.length;
    let h2 = 0x41c6ce57 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }

  async function api(path, options) {
    const response = await fetch(API + path, Object.assign({}, options, {
      headers: Object.assign({ Authorization: "Bearer " + accessToken }, options && options.headers)
    }));
    if (!response.ok) {
      const detail = await response.text();
      throw new Error("Google Drive 回應錯誤 (" + response.status + ")：" + detail.slice(0, 300));
    }
    return response.status === 204 ? null : response.json();
  }

  function requireGIS() {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      throw new Error("Google 登入元件尚未載入。請確認 index.html 已加入 Google Identity Services script。");
    }
    if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf("PASTE_") === 0) {
      throw new Error("尚未設定 OAuth Client ID。請在 app.js 的 GOOGLE_CLIENT_ID 填入用戶端 ID。");
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: function () {}
      });
    }
  }

  function getToken() {
    requireGIS();
    return new Promise(function (resolve, reject) {
      tokenClient.callback = function (result) {
        if (result && result.access_token) {
          accessToken = result.access_token;
          resolve(accessToken);
        } else {
          reject(new Error((result && result.error_description) || "Google 授權未完成。"));
        }
      };
      tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
    });
  }

  async function findRemote() {
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    const result = await api("/files?spaces=appDataFolder&q=" + q + "&fields=files(id,name,modifiedTime)&pageSize=10");
    return (result.files || [])[0] || null;
  }

  async function readRemote(file) {
    const result = await fetch(API + "/files/" + encodeURIComponent(file.id) + "?alt=media", {
      headers: { Authorization: "Bearer " + accessToken }
    });
    if (!result.ok) throw new Error("無法讀取雲端資料 (" + result.status + ")。");
    const raw = await result.text();
    let value;
    try { value = JSON.parse(raw); }
    catch (_) { throw new Error("雲端 JSON 格式無法解析；為避免覆蓋，已停止同步。"); }
    return { value, raw, hash: hash(raw), file };
  }

  async function createRemote(raw) {
    const boundary = "lifeerp_" + Math.random().toString(36).slice(2);
    const metadata = { name: FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" };
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) +
      "\r\n--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + raw + "\r\n--" + boundary + "--";
    const response = await fetch(UPLOAD_API + "/files?uploadType=multipart&fields=id,name,modifiedTime", {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "multipart/related; boundary=" + boundary },
      body
    });
    if (!response.ok) throw new Error("建立雲端檔案失敗 (" + response.status + ")：" + (await response.text()).slice(0, 300));
    return response.json();
  }

  async function updateRemote(file, raw) {
    // Check the revision immediately before writing; abort if another device changed it.
    const current = await findRemote();
    if (!current || current.id !== file.id || (file.modifiedTime && current.modifiedTime !== file.modifiedTime)) {
      throw new Error("雲端資料在同步期間已被其他裝置更新。這次沒有覆蓋；請重新載入雲端資料並處理衝突。");
    }
    const response = await fetch(UPLOAD_API + "/files/" + encodeURIComponent(file.id) + "?uploadType=media&fields=id,name,modifiedTime", {
      method: "PATCH",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: raw
    });
    if (!response.ok) throw new Error("更新雲端資料失敗 (" + response.status + ")：" + (await response.text()).slice(0, 300));
    return response.json();
  }

  function confirmChoice(message, choices) {
    // Prompt keeps this file usable without requiring changes to the existing UI.
    const answer = window.prompt(message + "\n\n" + choices.join("\n") + "\n\n請輸入選項編號：");
    return answer;
  }

  async function connectAndSync() {
    if (busy) return;
    busy = true;
    status("正在連結 Google Drive…");
    try {
      await getToken();
      const local = readLocal();
      const previous = getState();

      // Remote lookup and download always precede any possible upload.
      const remoteFile = await findRemote();
      if (remoteFile) {
        const remote = await readRemote(remoteFile);
        if (!local.exists) {
          writeLocal(remote.value);
          setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: hash(JSON.stringify(remote.value)), modifiedTime: remote.file.modifiedTime });
          status("已從 Google Drive 載入既有資料。", "success");
          return remote.value;
        }

        const localHash = hash(local.raw);
        const remoteChanged = !!previous.remoteHash && previous.remoteHash !== remote.hash;
        const localChanged = !!previous.localHash && previous.localHash !== localHash;

        // First connection on this device: cloud wins when both copies exist.
        if (!previous.remoteHash) {
          if (localHash === remote.hash) {
            setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: localHash, modifiedTime: remote.file.modifiedTime });
            status("本機與雲端資料相同，已完成連結。", "success");
            return local.value;
          }
          const choice = confirmChoice("找到 Google Drive 上的既有資料，而本機資料不同。系統先下載了雲端副本供比較；請明確選擇：", [
            "1：使用雲端版本（取代本機資料）",
            "2：保留本機版本並上傳取代雲端資料"
          ]);
          if (choice === "1") {
            writeLocal(remote.value);
            setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: remote.hash, modifiedTime: remote.file.modifiedTime });
            status("已採用雲端版本。", "success");
            return remote.value;
          }
          if (choice === "2") {
            const saved = await updateRemote(remote.file, local.raw);
            const nextHash = hash(local.raw);
            setState({ fileId: saved.id, remoteHash: nextHash, localHash: nextHash, modifiedTime: saved.modifiedTime });
            status("已依你的選擇上傳本機版本。", "success");
            return local.value;
          }
          setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: localHash, modifiedTime: remote.file.modifiedTime, pendingConflict: true });
          status("已保留兩份資料，尚未同步；再次按同步可重新選擇。", "warning");
          return null;
        }

        if (remoteChanged && localChanged && localHash !== remote.hash) {
          const choice = confirmChoice("偵測到本機和雲端都在上次同步後變更。沒有資料被覆蓋。請選擇：", [
            "1：採用雲端版本（取代本機資料）",
            "2：採用本機版本（上傳取代雲端資料）",
            "3：取消，稍後自行備份與合併"
          ]);
          if (choice === "1") {
            writeLocal(remote.value);
            setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: remote.hash, modifiedTime: remote.file.modifiedTime });
            status("已採用雲端版本。", "success");
            return remote.value;
          }
          if (choice === "2") {
            const saved = await updateRemote(remote.file, local.raw);
            setState({ fileId: saved.id, remoteHash: localHash, localHash: localHash, modifiedTime: saved.modifiedTime });
            status("已依你的選擇上傳本機版本。", "success");
            return local.value;
          }
          status("已取消同步；兩份資料均保留。", "warning");
          return null;
        }

        if (localHash !== remote.hash) {
          // A change on only one side is safe to propagate in the matching direction.
          if (localChanged && !remoteChanged) {
            const saved = await updateRemote(remote.file, local.raw);
            setState({ fileId: saved.id, remoteHash: localHash, localHash: localHash, modifiedTime: saved.modifiedTime });
            status("已將本機變更同步至 Google Drive。", "success");
            return local.value;
          }
          writeLocal(remote.value);
          setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: remote.hash, modifiedTime: remote.file.modifiedTime });
          status("已載入 Google Drive 上較新的資料。", "success");
          return remote.value;
        }

        setState({ fileId: remote.file.id, remoteHash: remote.hash, localHash: localHash, modifiedTime: remote.file.modifiedTime });
        status("本機與雲端資料一致。", "success");
        return local.value;
      }

      // No cloud file: blank local device may initialize an empty payload; non-empty data needs confirmation.
      if (!local.exists) {
        const answer = confirmChoice("Google Drive 尚無 LifeERP-data.json，本機也沒有資料。是否建立空白雲端資料檔？", ["1：建立空白資料檔", "2：取消"]);
        if (answer !== "1") { status("已取消；未建立或上傳任何資料。", "warning"); return null; }
        const raw = writeLocal({});
        const saved = await createRemote(raw);
        const currentHash = hash(raw);
        setState({ fileId: saved.id, remoteHash: currentHash, localHash: currentHash, modifiedTime: saved.modifiedTime });
        status("已建立空白雲端資料檔。", "success");
        return {};
      }

      const answer = confirmChoice("Google Drive 找不到資料檔，但本機有資料。只有在你確認這是第一次建立雲端資料時，才選擇上傳。", [
        "1：確認建立雲端檔並上傳本機資料",
        "2：取消，保留本機資料"
      ]);
      if (answer !== "1") { status("已取消；本機資料保留且沒有上傳。", "warning"); return null; }
      const saved = await createRemote(local.raw);
      const currentHash = hash(local.raw);
      setState({ fileId: saved.id, remoteHash: currentHash, localHash: currentHash, modifiedTime: saved.modifiedTime });
      status("已建立雲端資料檔並上傳本機資料。", "success");
      return local.value;
    } catch (error) {
      status(error.message || "同步失敗。", "error");
      window.alert("Google Drive 同步失敗：\n\n" + (error.message || "未知錯誤"));
      throw error;
    } finally {
      busy = false;
    }
  }

  async function saveAndSync(value) {
    // Call after a user edits data. Save locally first; explicit sync handles cloud conflicts.
    const raw = writeLocal(value);
    const state = getState();
    state.localHash = hash(raw);
    setState(state);
    return connectAndSync();
  }

  window.LifeERPSync = {
    connectAndSync: connectAndSync,
    saveAndSync: saveAndSync,
    getData: function () { return readLocal().value; },
    saveLocal: function (value) { writeLocal(value); },
    disconnect: function () {
      accessToken = null;
      if (window.google && google.accounts && google.accounts.oauth2 && tokenClient) {
        google.accounts.oauth2.revoke("", function () {});
      }
      status("已在此頁面登出 Google 授權。", "info");
    }
  };

  // Add a button only when the existing page has not provided its own sync control.
  document.addEventListener("DOMContentLoaded", function () {
    const existing = document.querySelector("[data-lifeerp-sync]");
    if (existing) {
      existing.addEventListener("click", function () {
        connectAndSync().catch(function (error) { console.error(error); });
      });
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "連結／同步 Google Drive";
    button.setAttribute("data-lifeerp-sync", "true");
    button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;padding:12px 16px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:inherit;box-shadow:0 2px 10px #0003";
    button.addEventListener("click", function () { connectAndSync().catch(function (error) { console.error(error); }); });
    document.body.appendChild(button);
  });
})();

// Minimal Life ERP UI layer for the supplied index.html. It keeps the app usable
// when the original v1 app.js is unavailable and stores the same payload used by
// LifeERPSync (localStorage: lifeErpData).
(function () {
  "use strict";
  const KEY = "lifeErpData";
  const blank = () => ({ tasks: [], goals: [], projects: [], transactions: [], habits: [] });
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY) || "null") || blank(); } catch (_) { data = blank(); }
  ["tasks", "goals", "projects", "transactions", "habits"].forEach(k => { if (!Array.isArray(data[k])) data[k] = []; });
  const save = () => { localStorage.setItem(KEY, JSON.stringify(data, null, 2)); const n = document.querySelector("#saveStatus"); if (n) n.textContent = "已儲存在此裝置"; };
  const esc = s => String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const money = n => "$" + Number(n || 0).toLocaleString("zh-TW");
  const list = (key, selector, render) => { const el = document.querySelector(selector); if (el) el.innerHTML = data[key].length ? data[key].map(render).join("") : '<div class="empty-state">目前沒有資料</div>'; };
  function render() {
    list("tasks", "#taskList", x => `<div class="list-item"><strong>${esc(x.title)}</strong><small>${esc(x.due || "")}</small><button data-del="tasks" data-id="${x.id}">刪除</button></div>`);
    list("goals", "#goalList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.description || "")}</p><button data-del="goals" data-id="${x.id}">刪除</button></article>`);
    list("projects", "#projectList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.description || "")}</p><button data-del="projects" data-id="${x.id}">刪除</button></article>`);
    list("habits", "#habitList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>連續 ${Number(x.streak || 0)} 天</p><button data-del="habits" data-id="${x.id}">刪除</button></article>`);
    list("transactions", "#transactionList", x => `<div class="list-item"><strong>${esc(x.title)}</strong><span>${x.type === "income" ? "+" : "-"}${money(x.amount)}</span><button data-del="transactions" data-id="${x.id}">刪除</button></div>`);
    const open = data.tasks.filter(x => !x.done).length, goals = data.goals.length, projects = data.projects.length;
    const income = data.transactions.filter(x => x.type === "income").reduce((a,x)=>a+Number(x.amount||0),0), expense = data.transactions.filter(x => x.type !== "income").reduce((a,x)=>a+Number(x.amount||0),0);
    const set = (s,v) => { const e=document.querySelector(s); if(e)e.textContent=v; };
    set("#statTasks", open); set("#statGoals", goals); set("#statProjects", projects); set("#statBalance", money(income-expense)); set("#financeIncome", money(income)); set("#financeExpense", money(expense)); set("#financeNet", money(income-expense));
    list("tasks", "#dashboardTasks", x => `<div class="list-item"><strong>${esc(x.title)}</strong></div>`); list("goals", "#dashboardGoals", x => `<div class="list-item"><strong>${esc(x.title)}</strong></div>`);
  }
  function add(kind) {
    const title = prompt("名稱"); if (!title) return;
    const item = { id: id(), title: title.trim(), createdAt: new Date().toISOString() };
    if (kind === "transactions") { const amount = prompt("金額"); if (!amount || isNaN(Number(amount))) return; item.amount = Number(amount); item.type = (prompt("輸入 income 表示收入；其他文字表示支出") || "expense").toLowerCase() === "income" ? "income" : "expense"; }
    if (kind === "habits") item.streak = 0;
    data[kind].unshift(item); save(); render();
  }
  document.addEventListener("click", e => {
    if (e.target.closest("#menuToggle")) {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) sidebar.classList.toggle("mobile-open");
      return;
    }
    const del = e.target.closest("[data-del]"); if (del) { data[del.dataset.del] = data[del.dataset.del].filter(x => x.id !== del.dataset.id); save(); render(); return; }
    const action = e.target.closest("[data-action]")?.dataset.action; const map = {"quick-task":"tasks","quick-goal":"goals","quick-project":"projects","quick-transaction":"transactions","quick-habit":"habits"}; if (action && map[action]) add(map[action]);
    const page = e.target.closest("[data-page], [data-page-link]")?.dataset.page || e.target.closest("[data-page-link]")?.dataset.pageLink; if (page) { document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active", x.id === "page-"+page)); document.querySelectorAll(".nav-item").forEach(x=>x.classList.toggle("active", x.dataset.page===page)); const sidebar=document.querySelector(".sidebar"); if(sidebar)sidebar.classList.remove("mobile-open"); }
    if (e.target.closest("#connectDrive, #syncButton")) window.LifeERPSync?.connectAndSync().then(()=>{ try { data=JSON.parse(localStorage.getItem(KEY)||"null")||data; render(); } catch(_){} }).catch(()=>{});
  });
  document.addEventListener("DOMContentLoaded", () => {
    render(); const t=document.querySelector("#todayLabel"); if(t)t.textContent=new Date().toLocaleDateString("zh-TW");
    const style = document.createElement("style");
    style.textContent = "@media (max-width: 800px){.sidebar.mobile-open{display:flex!important;visibility:visible!important;opacity:1!important;transform:translateX(0)!important;position:fixed;z-index:10000;inset:0 auto 0 0;width:min(82vw,320px);background:#fff;box-shadow:8px 0 24px #0003;overflow:auto}.sidebar.mobile-open + .main{filter:brightness(.7)}}";
    document.head.appendChild(style);
  });
})();
