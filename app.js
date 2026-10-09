/* 人生 ERP v1 - client-side app + optional Google Drive JSON sync.
   Setup instructions are in README.md. Never commit OAuth secrets other than a web client ID. */
const CONFIG = {
  // Replace with your Google OAuth 2.0 Web application client ID after setup.
  googleClientId: "PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com",
  driveFileName: "LifeERP-data.json"
};

const STORAGE_KEY = "life-erp-v1-data";
const DEFAULT_DATA = { version: 1, updatedAt: null, tasks: [], goals: [], projects: [], transactions: [], habits: [] };
let data = loadData();
let currentPage = "dashboard";
let activeEntryType = null;
let driveFileId = null;
let accessToken = null;
let tokenClient = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(Number(n) || 0);
const todayISO = () => new Date().toLocaleDateString("sv-SE");
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
const dateLabel = (date) => date ? new Date(`${date}T00:00:00`).toLocaleDateString("zh-TW", { month:"short", day:"numeric" }) : "未設定日期";

function loadData() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return parsed && parsed.version === 1 ? { ...structuredClone(DEFAULT_DATA), ...parsed } : structuredClone(DEFAULT_DATA);
  } catch { return structuredClone(DEFAULT_DATA); }
}
function saveData() {
  data.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  $("saveStatus").textContent = `已儲存於此裝置 · ${new Date().toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit"})}`;
  renderAll();
}
function id() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`); }
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function empty(message) { return `<div class="empty-state">${escapeHTML(message)}</div>`; }
function goPage(page) {
  currentPage = page;
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page-${page}`));
  document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const titles = {dashboard:"人生總覽",tasks:"任務管理",goals:"目標管理",projects:"專案管理",finance:"財務管理",habits:"習慣追蹤"};
  $("pageTitle").textContent = titles[page] || "人生 ERP";
  $("sidebar").classList.remove("open");
  renderAll();
}
function monthTransactions() {
  const month = todayISO().slice(0,7);
  return data.transactions.filter(t => (t.date || "").slice(0,7) === month);
}
function totals() {
  const tx = monthTransactions();
  const income = tx.filter(t=>t.kind==="income").reduce((s,t)=>s+Number(t.amount||0),0);
  const expense = tx.filter(t=>t.kind==="expense").reduce((s,t)=>s+Number(t.amount||0),0);
  return { income, expense, balance: income-expense };
}
function taskRow(t) {
  return `<div class="task-row ${t.done?"completed":""}"><input class="check" type="checkbox" data-toggle-task="${escapeHTML(t.id)}" ${t.done?"checked":""} aria-label="完成任務"><div class="item-main"><div class="item-title">${escapeHTML(t.title)}</div><div class="item-sub">${escapeHTML(t.category||"一般任務")} · ${t.due?dateLabel(t.due):"未設定期限"}</div></div><span class="pill ${t.done?"green":""}">${t.done?"已完成":escapeHTML(t.priority||"一般")}</span><button class="small-button danger" data-delete="tasks" data-id="${escapeHTML(t.id)}">刪除</button></div>`;
}
function goalCard(g) {
  const p = Math.max(0,Math.min(100,Number(g.progress)||0));
  return `<article class="entity-card"><div class="entity-top"><div><h3>${escapeHTML(g.title)}</h3><p>${escapeHTML(g.description||"尚未補充描述")}</p></div><span class="pill purple">${escapeHTML(g.status||"進行中")}</span></div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div><div class="progress-meta"><span>${g.due?`期限 ${dateLabel(g.due)}`:"持續進行"}</span><strong>${p}%</strong></div><div class="card-actions"><button class="small-button" data-progress-goal="${escapeHTML(g.id)}">＋ 進度 10%</button><button class="small-button danger" data-delete="goals" data-id="${escapeHTML(g.id)}">刪除</button></div></article>`;
}
function projectCard(p) {
  return `<article class="entity-card"><div class="entity-top"><div><h3>${escapeHTML(p.title)}</h3><p>${escapeHTML(p.description||"尚未補充描述")}</p></div><span class="pill ${p.status==="已完成"?"green":"purple"}">${escapeHTML(p.status||"進行中")}</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,Number(p.progress)||0))}%"></div></div><div class="progress-meta"><span>${p.due?`期限 ${dateLabel(p.due)}`:"未設定期限"}</span><strong>${Number(p.progress)||0}%</strong></div><div class="card-actions"><button class="small-button" data-progress-project="${escapeHTML(p.id)}">＋ 進度 10%</button><button class="small-button danger" data-delete="projects" data-id="${escapeHTML(p.id)}">刪除</button></div></article>`;
}
function renderAll() {
  const openTasks = data.tasks.filter(t=>!t.done);
  $("statTasks").textContent = openTasks.length;
  $("statGoals").textContent = data.goals.filter(g=>g.status!=="已完成").length;
  $("statProjects").textContent = data.projects.filter(p=>p.status!=="已完成").length;
  $("statBalance").textContent = money(totals().balance);
  $("financeIncome").textContent = money(totals().income);
  $("financeExpense").textContent = money(totals().expense);
  $("financeNet").textContent = money(totals().balance);
  $("financeNet").className = totals().balance < 0 ? "money-negative" : "money-positive";
  $("dashboardTasks").innerHTML = openTasks.length ? openTasks.slice(0,5).map(taskRow).join("") : empty("目前沒有待辦任務。新增一件小事，開始推進今天。");
  $("dashboardGoals").innerHTML = data.goals.length ? data.goals.slice(0,4).map(g=>`<div class="task-row"><div class="item-main"><div class="item-title">${escapeHTML(g.title)}</div><div class="item-sub">${g.due?`期限 ${dateLabel(g.due)}`:"持續進行"}</div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,Number(g.progress)||0))}%"></div></div></div><span class="pill purple">${Number(g.progress)||0}%</span></div>`).join("") : empty("還沒有目標。先建立一個你想完成的成果。");
  const filter = $("taskFilter").value;
  const query = $("taskSearch").value.trim().toLowerCase();
  const filtered = data.tasks.filter(t=>(filter==="all"||(filter==="open"?!t.done:t.done)) && (!query||`${t.title} ${t.category||""}`.toLowerCase().includes(query)));
  $("taskList").innerHTML = filtered.length ? filtered.map(taskRow).join("") : empty("找不到任務。你可以新增任務，或調整搜尋條件。");
  $("goalList").innerHTML = data.goals.length ? data.goals.map(goalCard).join("") : empty("還沒有目標。新增目標後，就能開始追蹤進度。");
  $("projectList").innerHTML = data.projects.length ? data.projects.map(projectCard).join("") : empty("還沒有專案。把一個想法整理成有期限、有進度的計畫。");
  const tx = [...data.transactions].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  $("transactionList").innerHTML = tx.length ? tx.map(t=>`<div class="transaction-row"><div class="item-main"><div class="item-title">${escapeHTML(t.title)}</div><div class="item-sub">${dateLabel(t.date)} · ${escapeHTML(t.category||"未分類")}</div></div><span class="${t.kind==="income"?"money-positive":"money-negative"}">${t.kind==="income"?"+":"−"}${money(t.amount)}</span><button class="small-button danger" data-delete="transactions" data-id="${escapeHTML(t.id)}">刪除</button></div>`).join("") : empty("還沒有收支紀錄。新增第一筆收入或支出，就能開始看見現金流。");
  $("habitList").innerHTML = data.habits.length ? data.habits.map(h=>`<article class="entity-card"><div class="entity-top"><div><h3>${escapeHTML(h.title)}</h3><p>${escapeHTML(h.frequency||"每天")} · ${escapeHTML(h.note||"持續累積")}</p></div><span class="pill ${h.checkedDate===todayISO()?"green":"purple"}">${h.checkedDate===todayISO()?"今日已完成":"今日待完成"}</span></div><div class="card-actions"><button class="small-button" data-check-habit="${escapeHTML(h.id)}">${h.checkedDate===todayISO()?"取消今日完成":"✓ 完成今天"}</button><button class="small-button danger" data-delete="habits" data-id="${escapeHTML(h.id)}">刪除</button></div></article>`).join("") : empty("還沒有習慣。可以從喝水、運動、學習或準時睡覺開始。");
}
const schemas = {
  tasks: {title:"新增任務", fields:[["title","任務名稱","text",true],["category","分類","select",false,["工作","個人","學習","健康","財務","一般任務"]],["due","截止日期","date"],["priority","優先程度","select",false,["高","一般","低"]]]},
  goals: {title:"新增目標", fields:[["title","目標名稱","text",true],["description","目標描述","textarea"],["due","預計完成日期","date"],["progress","目前進度（0–100）","number",false,null,0,100]]},
  projects: {title:"新增專案", fields:[["title","專案名稱","text",true],["description","專案說明","textarea"],["due","預計完成日期","date"],["progress","目前進度（0–100）","number",false,null,0,100]]},
  transactions: {title:"新增收支", fields:[["title","項目名稱","text",true],["kind","類型","select",true,["expense","income"],["支出","收入"]],["amount","金額（新台幣）","number",true,null,0],["category","分類","select",false,["餐飲","交通","生活","薪資","接案","課程","貸款","其他"]],["date","日期","date",true]]},
  habits: {title:"新增習慣", fields:[["title","習慣名稱","text",true],["frequency","頻率","select",false,["每天","每週","工作日","自訂"]],["note","備註","text"]]}
};
function addField(key,label,type,required,options,optionLabels,min,max) {
  let control = "";
  if(type==="select") {
    control = `<select name="${key}" ${required?"required":""}>${options.map((v,i)=>`<option value="${escapeHTML(v)}">${escapeHTML(optionLabels?optionLabels[i]:v)}</option>`).join("")}</select>`;
  } else if(type==="textarea") control = `<textarea name="${key}" ${required?"required":""} placeholder="補充說明（選填）"></textarea>`;
  else control = `<input name="${key}" type="${type}" ${required?"required":""} ${min!==undefined?`min="${min}"`:""} ${max!==undefined?`max="${max}"`:""} ${type==="date"&&key==="date"?`value="${todayISO()}"`:""} placeholder="${type==="number"?"0":""}">`;
  return `<div class="form-field"><label for="field-${key}">${escapeHTML(label)}${required?' *':""}</label>${control.replace(`<${type==="select"?"select":type==="textarea"?"textarea":"input"} `,`<${type==="select"?"select":type==="textarea"?"textarea":"input"} id="field-${key}" `)}</div>`;
}
function openEntry(type) {
  const schema=schemas[type]; if(!schema)return;
  activeEntryType=type; $("dialogTitle").textContent=schema.title;
  $("formFields").innerHTML=schema.fields.map(([key,label,kind,required=false,options=null,extra=null,max=null])=>{
    const optionLabels=Array.isArray(extra)?extra:null;
    const min=kind==="number"?(key==="progress"?0:0):undefined;
    const maxVal=key==="progress"?100:undefined;
    return addField(key,label,kind,required,options,optionLabels,min,maxVal);
  }).join("");
  // Dates default to today for transaction; other dates remain optional.
  if(type==="transactions") { const dateInput=$('field-date'); if(dateInput)dateInput.value=todayISO(); }
  $("entryDialog").showModal();
}
function handleEntrySubmit(event) {
  event.preventDefault();
  const form=new FormData($("entryForm")); const item={id:id()};
  for(const [k,v] of form.entries()) item[k]=v;
  if(!item.title?.trim()){toast("請先輸入名稱");return;}
  if(activeEntryType==="tasks") {item.done=false; item.priority=item.priority||"一般"; data.tasks.unshift(item);}
  if(activeEntryType==="goals") {item.progress=Number(item.progress)||0;item.status=item.progress>=100?"已完成":"進行中";data.goals.unshift(item);}
  if(activeEntryType==="projects") {item.progress=Number(item.progress)||0;item.status=item.progress>=100?"已完成":"進行中";data.projects.unshift(item);}
  if(activeEntryType==="transactions") {item.amount=Number(item.amount)||0;item.kind=item.kind||"expense";item.date=item.date||todayISO();data.transactions.unshift(item);}
  if(activeEntryType==="habits") {item.frequency=item.frequency||"每天";data.habits.unshift(item);}
  $("entryDialog").close(); $("entryForm").reset(); saveData(); toast("已新增並儲存");
}
function deleteItem(type,itemId) {
  if(!confirm("確定要刪除這筆資料嗎？此操作無法復原。"))return;
  data[type]=data[type].filter(x=>x.id!==itemId); saveData(); toast("已刪除");
}
function initGoogleAuth() {
  if(!window.google?.accounts?.oauth2) return false;
  if(CONFIG.googleClientId.startsWith("PASTE_")) { toast("請先依 README 設定 Google OAuth Client ID"); return false; }
  tokenClient=google.accounts.oauth2.initTokenClient({
    client_id:CONFIG.googleClientId,
    scope:"https://www.googleapis.com/auth/drive.file",
    callback: async (response) => {
      if(response.error) { toast("Google 授權失敗，請再試一次"); return; }
      accessToken=response.access_token;
      setDriveStatus(true,"Google Drive 已連結");
      await loadFromDrive();
    }
  });
  tokenClient.requestAccessToken({prompt:"consent"});
  return true;
}
async function driveRequest(url,options={}) {
  const response=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${accessToken}`}});
  if(!response.ok) throw new Error(`Google Drive API ${response.status}: ${await response.text()}`);
  if(response.status===204) return null;
  return response.json();
}
async function findDriveFile() {
  const q=encodeURIComponent(`name='${CONFIG.driveFileName}' and trashed=false`);
  const result=await driveRequest(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=100&fields=files(id,name,modifiedTime,mimeType)`);
  return result.files?.sort((a,b)=>(b.modifiedTime||"").localeCompare(a.modifiedTime||""))[0]||null;
}
async function syncToDrive() {
  if(!accessToken) { toast("請先連結 Google Drive"); return; }
  $("syncButton").disabled=true; $("syncButton").textContent="同步中…";
  try {
    const existing=await findDriveFile();
    const payload=JSON.stringify({...data,updatedAt:new Date().toISOString()},null,2);
    if(existing) {
      driveFileId=existing.id;
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,{method:"PATCH",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json"},body:payload}).then(async r=>{if(!r.ok)throw new Error(`更新失敗 (${r.status})`);});
    } else {
      const boundary="life_erp_boundary";
      const metadata={name:CONFIG.driveFileName,mimeType:"application/json"};
      const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const created=await driveRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",{method:"POST",headers:{"Content-Type":`multipart/related; boundary=${boundary}`},body});
      driveFileId=created.id;
    }
    setDriveStatus(true,"Google Drive 已同步");
    $("saveStatus").textContent=`雲端同步完成 · ${new Date().toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit"})}`;
    toast("資料已同步到 Google Drive");
  } catch(error) {
    console.error(error); toast("同步失敗，請檢查網路與 Google 設定");
  } finally {
    $("syncButton").disabled=false; $("syncButton").textContent="同步資料";
  }
}
async function loadFromDrive() {
  if(!accessToken) { toast("請先連結 Google Drive"); return; }
  try {
    const file=await findDriveFile();
    if(!file) { toast("雲端還沒有資料檔，將先上傳此裝置資料"); await syncToDrive(); return; }
    driveFileId=file.id;
    const remote=await driveRequest(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`);
    if(!remote || remote.version!==1) throw new Error("資料檔格式不相容");
    const localTime=Date.parse(data.updatedAt||"1970-01-01");
    const remoteTime=Date.parse(remote.updatedAt||file.modifiedTime||"1970-01-01");
    if(localTime>remoteTime && data.tasks.length+data.goals.length+data.projects.length+data.transactions.length+data.habits.length>0) {
      if(!confirm("本機資料比雲端資料新。要以本機資料覆蓋雲端嗎？按「取消」則改用雲端資料。")) {
        data={...structuredClone(DEFAULT_DATA),...remote}; localStorage.setItem(STORAGE_KEY,JSON.stringify(data)); renderAll(); toast("已載入 Google Drive 資料");
      } else await syncToDrive();
    } else {
      data={...structuredClone(DEFAULT_DATA),...remote}; localStorage.setItem(STORAGE_KEY,JSON.stringify(data)); renderAll(); toast("已載入 Google Drive 資料");
    }
    setDriveStatus(true,"Google Drive 已連結");
  } catch(error) { console.error(error); toast("讀取雲端失敗，請確認資料檔與權限"); }
}
function setDriveStatus(connected,label) {
  $("driveStatus").innerHTML=`<span class="status-dot ${connected?"connected":""}"></span><span>${escapeHTML(label)}</span>`;
}
function init() {
  $("todayLabel").textContent=new Date().toLocaleDateString("zh-TW",{month:"short",day:"numeric",weekday:"short"});
  $("nav").addEventListener("click",e=>{const button=e.target.closest("[data-page]");if(button)goPage(button.dataset.page);});
  document.body.addEventListener("click",e=>{
    const pageLink=e.target.closest("[data-page-link]"); if(pageLink)goPage(pageLink.dataset.pageLink);
    const action=e.target.closest("[data-action]"); if(action){const map={"quick-task":"tasks","quick-goal":"goals","quick-project":"projects","quick-transaction":"transactions","quick-habit":"habits"};openEntry(map[action.dataset.action]);}
    const del=e.target.closest("[data-delete]");if(del)deleteItem(del.dataset.delete,del.dataset.id);
    const goal=e.target.closest("[data-progress-goal]");if(goal){const item=data.goals.find(x=>x.id===goal.dataset.progressGoal);if(item){item.progress=Math.min(100,(Number(item.progress)||0)+10);item.status=item.progress>=100?"已完成":"進行中";saveData();}}
    const project=e.target.closest("[data-progress-project]");if(project){const item=data.projects.find(x=>x.id===project.dataset.progressProject);if(item){item.progress=Math.min(100,(Number(item.progress)||0)+10);item.status=item.progress>=100?"已完成":"進行中";saveData();}}
    const habit=e.target.closest("[data-check-habit]");if(habit){const item=data.habits.find(x=>x.id===habit.dataset.checkHabit);if(item){item.checkedDate=item.checkedDate===todayISO()?"":todayISO();saveData();}}
    const quickToggle=e.target.closest("[data-toggle-task]");if(quickToggle){const item=data.tasks.find(x=>x.id===quickToggle.dataset.toggleTask);if(item){item.done=quickToggle.checked;saveData();}}
  });
  $("taskFilter").addEventListener("change",renderAll); $("taskSearch").addEventListener("input",renderAll);
  $("entryForm").addEventListener("submit",handleEntrySubmit);
  $("closeDialog").addEventListener("click",()=>$("entryDialog").close());
  $("cancelEntry").addEventListener("click",()=>$("entryDialog").close());
  $("connectDrive").addEventListener("click",initGoogleAuth);
  $("syncButton").addEventListener("click",async()=>{if(accessToken)await syncToDrive();else initGoogleAuth();});
  $("menuToggle").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
  $("sidebar").id="sidebar";
  renderAll();
  if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(console.warn);
}
document.addEventListener("DOMContentLoaded",init);
