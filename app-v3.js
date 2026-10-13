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
    const existing = document.querySelector("[data-lifeerp-sync], #connectDrive, #syncButton");
    if (existing) {
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
  const SCHEMA_VERSION = 4;
  const blank = () => ({ schemaVersion: SCHEMA_VERSION, updatedAt: null, people: [], tasks: [], dreams: [], goals: [], orr: [], projects: [], transactions: [], habits: [], workProfiles: [], things: [], timeEntries: [], learning: [], health: [], assets: [] });
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY) || "null") || blank(); } catch (_) { data = blank(); }
  ["people", "tasks", "dreams", "goals", "orr", "projects", "transactions", "habits", "workProfiles", "things", "timeEntries", "learning", "health", "assets"].forEach(k => { if (!Array.isArray(data[k])) data[k] = []; });
  data.schemaVersion = SCHEMA_VERSION;
  const save = () => { data.updatedAt = new Date().toISOString(); localStorage.setItem(KEY, JSON.stringify(data, null, 2)); const n = document.querySelector("#saveStatus"); if (n) n.textContent = "已儲存在此裝置"; };
  const esc = s => String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const money = n => "$" + Number(n || 0).toLocaleString("zh-TW");
  const list = (key, selector, render) => { const el = document.querySelector(selector); if (el) el.innerHTML = data[key].length ? data[key].map(render).join("") : '<div class="empty-state">目前沒有資料</div>'; };
  function render() {
    list("people", "#peopleList", x => `<article class="entity-card"><div class="entity-top"><div><h3>${esc(x.title)}</h3><p>${esc(x.role || x.relationship || "尚未設定角色")}</p></div><span class="pill">${esc(x.type || "人物")}</span></div><div class="dream-meta"><span>${esc(x.contact || "尚未填寫聯絡方式")}</span><span>${esc(x.description || "")}</span></div><div class="card-actions"><button class="small-button danger" data-del="people" data-id="${x.id}">刪除</button></div></article>`);
    list("tasks", "#taskList", x => `<div class="list-item"><div class="item-main"><strong>${esc(x.title)}</strong><small>${esc(x.due || "")}</small></div><span class="pill">${esc(x.quadrantLabel || "未分類")}</span><button data-del="tasks" data-id="${x.id}">刪除</button></div>`);
    list("goals", "#goalList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.description || "")}</p><button data-del="goals" data-id="${x.id}">刪除</button></article>`);
    list("projects", "#projectList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.description || "")}</p><button data-del="projects" data-id="${x.id}">刪除</button></article>`);
    list("habits", "#habitList", x => `<article class="card"><h3>${esc(x.title)}</h3><p>連續 ${Number(x.streak || 0)} 天</p><button data-del="habits" data-id="${x.id}">刪除</button></article>`);
    list("transactions", "#transactionList", x => `<div class="list-item"><strong>${esc(x.title)}</strong><span>${x.type === "income" ? "+" : "-"}${money(x.amount)}</span><button data-del="transactions" data-id="${x.id}">刪除</button></div>`);
    list("dreams", "#dreamList", x => `<article class="entity-card"><div class="entity-top"><div><h3>${esc(x.title)}</h3><p>${esc(x.reason || x.description || "還沒有補充說明")}</p></div><span class="pill ${x.feasibility === "feasible" ? "green" : "purple"}">${x.feasibilityLabel || "尚未評估"}</span></div><div class="dream-meta"><span>預估金額：${x.estimatedCost ? money(x.estimatedCost) : "未填"}</span><span>預估時間：${x.estimatedHours ? esc(x.estimatedHours) + " 小時" : "未填"}</span></div><div class="card-actions"><button class="small-button" data-promote-dream="${x.id}">轉為目標</button><button class="small-button danger" data-del="dreams" data-id="${x.id}">刪除</button></div></article>`);
    list("orr", "#orrList", x => `<article class="entity-card"><div class="entity-top"><div><h3>${esc(x.title)}</h3><p>${esc(x.description || "")}</p></div><span class="pill">${esc(x.kind || "ORR 節點")}</span></div><div class="dream-meta"><span>連結目標：${esc((data.goals.find(g => g.id === x.goalId) || {}).title || "未指定")}</span><span>狀態：${esc(x.status || "規劃中")}</span></div><div class="card-actions"><button class="small-button danger" data-del="orr" data-id="${x.id}">刪除</button></div></article>`);
    list("workProfiles", "#workList", x => `<article class="entity-card"><div class="entity-top"><div><h3>${esc(x.title)}</h3><p>${esc(x.typeLabel || "工作／收入來源")} · ${x.stable === "yes" ? "固定收入" : "收入可變"}</p></div><span class="pill green">${money(x.monthlyIncome || 0)}／月</span></div><div class="dream-meta"><span>工作：${esc(x.hoursPerWeek || 0)} 小時／週</span><span>可投入：${esc(x.availableHours || 0)} 小時／週</span></div><div class="card-actions"><button class="small-button danger" data-del="workProfiles" data-id="${x.id}">刪除</button></div></article>`);
    list("things", "#thingsList", x => `<article class="entity-card"><div class="entity-top"><div><h3>${esc(x.title)}</h3><p>${esc(x.categoryLabel || "物品")} · ${esc(x.status || "使用中")}</p></div><span class="pill">${x.value ? money(x.value) : "未估值"}</span></div><div class="dream-meta"><span>${esc(x.location || "未填寫位置")}</span><span>${x.expiryDate ? "到期：" + esc(x.expiryDate) : "無到期日"}</span></div><div class="card-actions"><button class="small-button danger" data-del="things" data-id="${x.id}">刪除</button></div></article>`);
    const open = data.tasks.filter(x => !x.done).length, goals = data.goals.length, projects = data.projects.length;
    const income = data.transactions.filter(x => x.type === "income").reduce((a,x)=>a+Number(x.amount||0),0), expense = data.transactions.filter(x => x.type !== "income").reduce((a,x)=>a+Number(x.amount||0),0);
    const set = (s,v) => { const e=document.querySelector(s); if(e)e.textContent=v; };
    const resourceIncome = data.workProfiles.reduce((a,x)=>a+Number(x.monthlyIncome||0),0);
    const resourceHours = data.workProfiles.reduce((a,x)=>a+Number(x.hoursPerWeek||0),0);
    const resourceFreeHours = data.workProfiles.reduce((a,x)=>a+Number(x.availableHours||0),0);
    set("#statTasks", open); set("#statGoals", goals); set("#statProjects", projects); set("#statBalance", money(income-expense)); set("#financeIncome", money(income)); set("#financeExpense", money(expense)); set("#financeNet", money(income-expense)); set("#resourceIncome", money(resourceIncome)); set("#resourceHours", resourceHours + " 小時"); set("#resourceFreeHours", resourceFreeHours + " 小時");
    list("tasks", "#dashboardTasks", x => `<div class="list-item"><strong>${esc(x.title)}</strong></div>`); list("goals", "#dashboardGoals", x => `<div class="list-item"><strong>${esc(x.title)}</strong></div>`);
    const relationItems = [
      ...data.transactions.map(x => ({ item: x, link: x.personId || x.thingId || x.goalId || x.projectId })),
      ...data.projects.map(x => ({ item: x, link: x.goalId })),
      ...data.tasks.map(x => ({ item: x, link: x.goalId || x.projectId })),
      ...data.habits.map(x => ({ item: x, link: x.goalId })),
      ...data.orr.map(x => ({ item: x, link: x.goalId || x.dreamId }))
    ];
    const linked = relationItems.filter(x => x.link).length;
    const total = relationItems.length;
    set("#relationSummary", total ? `已連結 ${linked}/${total} 筆` : "尚未建立資料");
    set("#relationHint", total ? (linked === total ? "目前所有執行資料都有上層關聯，之後可以直接從目標追蹤到實際行動。" : `目前有 ${total - linked} 筆資料尚未連到目標或專案；這些資料仍可使用，之後可以補上關聯。`) : "建立資料後，這裡會顯示目標、專案、任務與資源的連結狀況。");
  }
  let entryKind = null;
  const dialog = () => document.querySelector("#entryDialog");
  const field = (label, name, type = "text", options = {}) => {
    const optional = options.optional !== false ? "（可留白）" : "";
    if (type === "textarea") return `<div class="form-field"><label for="entry-${name}">${label}${optional}</label><textarea id="entry-${name}" name="${name}" placeholder="${options.placeholder || ""}"></textarea></div>`;
    if (type === "select") return `<div class="form-field"><label for="entry-${name}">${label}${optional}</label><select id="entry-${name}" name="${name}"><option value="">未指定</option>${(options.items || []).map(x => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("")}</select></div>`;
    return `<div class="form-field"><label for="entry-${name}">${label}${optional}</label><input id="entry-${name}" name="${name}" type="${type}" ${options.required ? "required" : ""} placeholder="${options.placeholder || ""}"></div>`;
  };
  const goalOptions = () => data.goals.map(x => ({ value: x.id, label: x.title }));
  const projectOptions = () => data.projects.map(x => ({ value: x.id, label: x.title }));
  const orrOptions = () => data.orr.map(x => ({ value: x.id, label: x.title }));
  function openEntryDialog(kind) {
    const node = dialog(); if (!node) return;
    entryKind = kind;
    const titles = { people: "新增人物", tasks: "新增任務", dreams: "新增夢想", goals: "新增目標", orr: "新增 ORR 節點", projects: "新增專案", transactions: "新增收支", habits: "新增習慣", workProfiles: "新增工作／收入", things: "新增物品" };
    const peopleOptions = () => data.people.map(x => ({ value: x.id, label: x.title }));
    const thingOptions = () => data.things.map(x => ({ value: x.id, label: x.title }));
    const fields = {
      people: field("姓名／名稱", "title", "text", { required: true, optional: false }) + field("關係或角色", "relationship") + field("工作／身份", "role") + field("聯絡方式", "contact") + field("備註", "description", "textarea"),
      tasks: field("任務名稱", "title", "text", { required: true, optional: false }) + field("說明", "description", "textarea") + field("到期日", "due", "date") + field("四象限", "quadrant", "select", { items: [{ value: "important-urgent", label: "重要且緊急" }, { value: "important-not-urgent", label: "重要但不緊急" }, { value: "not-important-urgent", label: "不重要但緊急" }, { value: "not-important-not-urgent", label: "不重要且不緊急" }] }) + field("預估時間（分鐘）", "estimatedMinutes", "number") + field("所屬目標", "goalId", "select", { items: goalOptions() }) + field("所屬專案", "projectId", "select", { items: projectOptions() }),
      dreams: field("夢想名稱", "title", "text", { required: true, optional: false }) + field("為什麼想完成", "reason", "textarea") + field("目前的阻礙", "barrier", "textarea") + field("預估花費", "estimatedCost", "number") + field("預估投入時間（小時）", "estimatedHours", "number") + field("理想完成日期", "deadline", "date") + field("重要程度", "importance", "select", { items: [{ value: "high", label: "重要" }, { value: "medium", label: "普通" }, { value: "low", label: "低" }] }) + field("目前可行性", "feasibility", "select", { items: [{ value: "unassessed", label: "尚未評估" }, { value: "feasible", label: "可行" }, { value: "adjust", label: "需要調整" }, { value: "not-yet", label: "目前不可行" }] }),
      goals: field("目標名稱", "title", "text", { required: true, optional: false }) + field("說明", "description", "textarea") + field("目標日期", "targetDate", "date") + field("目標數值", "targetValue", "number"),
      orr: field("ORR 節點名稱", "title", "text", { required: true, optional: false }) + field("這個節點要完成什麼", "description", "textarea") + field("節點類型", "kind", "select", { items: [{ value: "objective", label: "方向／Objective" }, { value: "result", label: "結果／Result" }, { value: "roadmap", label: "路徑／Roadmap" }, { value: "subgoal", label: "小目標" }] }) + field("所屬夢想", "dreamId", "select", { items: data.dreams.map(x => ({ value: x.id, label: x.title })) }) + field("所屬目標", "goalId", "select", { items: goalOptions() }) + field("上層 ORR 節點", "parentId", "select", { items: orrOptions() }),
      projects: field("專案名稱", "title", "text", { required: true, optional: false }) + field("說明", "description", "textarea") + field("截止日", "due", "date") + field("預算", "budget", "number") + field("所屬目標", "goalId", "select", { items: goalOptions() }),
      transactions: field("項目名稱", "title", "text", { required: true, optional: false }) + field("金額", "amount", "number", { placeholder: "未填寫會以 0 計算" }) + field("類型", "type", "select", { items: [{ value: "expense", label: "支出" }, { value: "income", label: "收入" }] }) + field("日期", "date", "date") + field("分類", "category") + field("相關人物", "personId", "select", { items: peopleOptions() }) + field("相關物品", "thingId", "select", { items: thingOptions() }) + field("所屬目標", "goalId", "select", { items: goalOptions() }) + field("所屬專案", "projectId", "select", { items: projectOptions() }) + field("備註", "description", "textarea"),
      habits: field("習慣名稱", "title", "text", { required: true, optional: false }) + field("頻率", "frequency", "select", { items: [{ value: "daily", label: "每天" }, { value: "weekly", label: "每週" }, { value: "custom", label: "自訂" }] }) + field("所屬目標", "goalId", "select", { items: goalOptions() }) + field("備註", "description", "textarea"),
      workProfiles: field("工作／收入來源名稱", "title", "text", { required: true, optional: false }) + field("類型", "typeLabel", "select", { items: [{ value: "正職", label: "正職" }, { value: "兼職", label: "兼職" }, { value: "自由接案", label: "自由接案" }, { value: "其他收入", label: "其他收入" }] }) + field("每月預估收入", "monthlyIncome", "number") + field("每週工作時間", "hoursPerWeek", "number") + field("每週可投入目標的時間", "availableHours", "number") + field("收入是否固定", "stable", "select", { items: [{ value: "yes", label: "固定" }, { value: "no", label: "不固定" }] }) + field("備註", "description", "textarea"),
      things: field("物品／資產名稱", "title", "text", { required: true, optional: false }) + field("類別", "categoryLabel", "select", { items: [{ value: "設備", label: "設備" }, { value: "文件", label: "文件／合約" }, { value: "訂閱", label: "軟體／訂閱" }, { value: "其他", label: "其他" }] }) + field("目前狀態", "status", "select", { items: [{ value: "使用中", label: "使用中" }, { value: "閒置", label: "閒置" }, { value: "待維修", label: "待維修" }, { value: "已淘汰", label: "已淘汰" }] }) + field("目前價值", "value", "number") + field("位置", "location") + field("到期／保固日期", "expiryDate", "date") + field("備註", "description", "textarea")
    }[kind];
    node.querySelector("#dialogTitle").textContent = titles[kind] || "新增項目";
    node.querySelector("#formFields").innerHTML = fields || "";
    node.showModal();
  }
  function submitEntry(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    if (!values.title || !values.title.trim()) return;
    const item = { id: id(), title: values.title.trim(), createdAt: new Date().toISOString(), status: "active", goalId: values.goalId || null, projectId: values.projectId || null };
    ["description", "reason", "barrier", "due", "targetDate", "targetValue", "estimatedMinutes", "budget", "frequency", "date", "category", "deadline", "importance", "feasibility", "estimatedCost", "estimatedHours", "dreamId", "kind", "typeLabel", "monthlyIncome", "hoursPerWeek", "availableHours", "stable", "quadrant", "parentId", "relationship", "role", "contact", "personId", "thingId", "categoryLabel", "status", "value", "location", "expiryDate"].forEach(key => { if (values[key]) item[key] = values[key]; });
    if (entryKind === "tasks") { item.status = "open"; item.done = false; item.estimatedMinutes = Number(values.estimatedMinutes || 0); item.actualMinutes = 0; item.quadrantLabel = ({ "important-urgent": "重要且緊急", "important-not-urgent": "重要但不緊急", "not-important-urgent": "不重要但緊急", "not-important-not-urgent": "不重要且不緊急" }[values.quadrant || ""] || "未分類"); }
    if (entryKind === "goals") { item.progress = 0; }
    if (entryKind === "dreams") { item.feasibilityLabel = ({ feasible: "可行", adjust: "需要調整", "not-yet": "目前不可行", unassessed: "尚未評估" }[values.feasibility || "unassessed"]); }
    if (entryKind === "orr") { item.kind = values.kind || "subgoal"; item.status = "規劃中"; }
    if (entryKind === "projects") { item.progress = 0; item.budget = Number(values.budget || 0); }
    if (entryKind === "transactions") { item.amount = Number(values.amount || 0); item.type = values.type || "expense"; item.date = values.date || new Date().toISOString().slice(0, 10); item.category = values.category || "other"; }
    if (entryKind === "habits") item.streak = 0;
    if (entryKind === "workProfiles") { item.monthlyIncome = Number(values.monthlyIncome || 0); item.hoursPerWeek = Number(values.hoursPerWeek || 0); item.availableHours = Number(values.availableHours || 0); }
    if (entryKind === "things") { item.value = Number(values.value || 0); item.status = values.status || "使用中"; item.categoryLabel = values.categoryLabel || "其他"; }
    data[entryKind].unshift(item); save(); render(); dialog().close(); form.reset();
  }
  document.addEventListener("click", e => {
    const del = e.target.closest("[data-del]"); if (del) { data[del.dataset.del] = data[del.dataset.del].filter(x => x.id !== del.dataset.id); save(); render(); return; }
    const promote = e.target.closest("[data-promote-dream]");
    if (promote) {
      const dream = data.dreams.find(x => x.id === promote.dataset.promoteDream);
      if (dream && !data.goals.some(x => x.dreamId === dream.id)) {
        data.goals.unshift({ id: id(), title: dream.title, description: dream.reason || "從夢想清單轉入的目標", createdAt: new Date().toISOString(), status: "active", progress: 0, dreamId: dream.id, goalId: null, projectId: null });
        dream.feasibility = "feasible"; dream.feasibilityLabel = "已轉為目標";
        save(); render();
      }
      return;
    }
    const action = e.target.closest("[data-action]")?.dataset.action; const map = {"quick-person":"people","quick-task":"tasks","quick-dream":"dreams","quick-goal":"goals","quick-orr":"orr","quick-project":"projects","quick-transaction":"transactions","quick-habit":"habits","quick-work":"workProfiles","quick-thing":"things"}; if (action && map[action]) openEntryDialog(map[action]);
    const page = e.target.closest("[data-page], [data-page-link]")?.dataset.page || e.target.closest("[data-page-link]")?.dataset.pageLink; if (page) { document.querySelectorAll(".page").forEach(x=>x.classList.toggle("active", x.id === "page-"+page)); document.querySelectorAll(".nav-item").forEach(x=>x.classList.toggle("active", x.dataset.page===page)); const pageTitles = { dashboard: "人生總覽", people: "人際與角色", resources: "工作與收入", dreams: "夢想清單", goals: "目標管理", orr: "ORR 拆解", projects: "專案管理", tasks: "任務管理", habits: "習慣追蹤", things: "資產與物品", finance: "財務管理" }; const title = document.querySelector("#pageTitle"); if (title) title.textContent = pageTitles[page] || "人生 ERP"; const sidebar=document.querySelector(".sidebar"); if(sidebar)sidebar.classList.remove("open"); }
    if (e.target.closest("#connectDrive, #syncButton")) window.LifeERPSync?.connectAndSync().then(()=>{ try { data=JSON.parse(localStorage.getItem(KEY)||"null")||data; render(); } catch(_){} }).catch(()=>{});
  });
  document.addEventListener("DOMContentLoaded", () => {
    const menu = document.querySelector("#menuToggle");
    const sidebar = document.querySelector(".sidebar");
    if (menu && sidebar) menu.addEventListener("click", () => sidebar.classList.toggle("open"));
    const form = document.querySelector("#entryForm");
    if (form) form.addEventListener("submit", event => { event.preventDefault(); submitEntry(form); });
    document.querySelector("#cancelEntry")?.addEventListener("click", () => dialog()?.close());
    document.querySelector("#closeDialog")?.addEventListener("click", () => dialog()?.close());
    const themeSelect = document.querySelector("#themeSelect");
    const applyTheme = theme => { const next = ["gold", "steel"].includes(theme) ? theme : "dark"; document.documentElement.dataset.theme = next; localStorage.setItem("lifeErpTheme", next); if (themeSelect) themeSelect.value = next; };
    applyTheme(localStorage.getItem("lifeErpTheme") || "dark");
    themeSelect?.addEventListener("change", event => applyTheme(event.target.value));
    render(); const t=document.querySelector("#todayLabel"); if(t)t.textContent=new Date().toLocaleDateString("zh-TW");
    const style = document.createElement("style");
    style.textContent = "@media (max-width: 800px){.sidebar.open{display:flex!important;visibility:visible!important;opacity:1!important;transform:translateX(0)!important;position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:0!important;width:min(82vw,320px)!important;height:100vh!important;z-index:2147483647!important;background:var(--paper)!important;color:var(--ink)!important;box-shadow:8px 0 24px #0008;overflow:auto!important}.sidebar.open .nav-item{color:var(--muted)!important}.sidebar.open .nav-item.active{color:var(--accent)!important;background:var(--accent-soft)!important}.sidebar.open .side-note,.sidebar.open .drive-status{color:var(--muted)!important}.sidebar.open + .main{filter:brightness(.7)}}";
    document.head.appendChild(style);
  });
})();
