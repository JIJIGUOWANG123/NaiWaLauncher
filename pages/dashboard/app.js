// ============================================================
// 自定义娱乐 · 配置页面前端 (v1.7.2 · 方案三 + 超时保护)
// 读取：桥接 apiGet 优先，超时/失败自动降级 fetch
// 保存：桥接 apiPost 优先，超时/失败自动降级 fetch
// ============================================================

const bridge = window.AstrBotPluginPage;

// ── 全局状态 ──
let SCHEMA = {};
let BIRD_FILES = [];          // 小鸟素材文件名（从后端 /birdfiles 拉）
let BIRD_RENDER_BASE = "";    // 渲染服务地址（预览用）
let BIRD_CUSTOM_DIR = "";     // 手动指定的素材目录（空=用配置里的）
let BIRD_BROWSE = null;       // 目录浏览器状态 {dir, dirs, files}
let BIRD_STATUS = null;       // 图片识别结果 {dir, resolved:{}, missing:[]}
// ★ 1.7.6：坐骑图片自动识别（和小鸟同一套）
let MOUNT_STATUS = null;      // {dir, resolved:{}, missing:[], total, count}
let MOUNT_FILES = [];         // 素材目录里的文件名
let MOUNT_CUSTOM_DIR = "";    // 手动指定的坐骑素材目录
// ★★ 1.7.7：银行冻结账号（后台查看 / 提前解冻）
let BANK_FROZEN = null;       // null=未加载；[]=没有冻结；[{...}]=冻结中
let BANK_FROZEN_ERR = "";
let CONFIG = {};
let currentView = "menu";
let bridgeReady = false;

const PLUGIN_ID = "astrbot_plugin_custom_entertainment";

// ── 工具 ──
const $ = (id) => document.getElementById(id);
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/**
 * 渲染服务地址。
 *
 * 优先用配置里的 output_render_base（和图片接口同一个服务），
 * 没配才回落到本机默认值。
 */
function birdRenderBase() {
  if (BIRD_RENDER_BASE) return BIRD_RENDER_BASE;
  const fromCfg = (CONFIG && CONFIG.output_render_base) || "";
  const base = String(fromCfg || "http://127.0.0.1:5099").trim();
  return base.replace(/\/+$/, "");
}

/** 小鸟素材预览图 URL（走后端代理，避免跨域/鉴权） */
function birdPreviewUrl(name, dir) {
  if (!name) return "";
  // 渲染服务与本机后台可直连（同机 127.0.0.1），直接用它的预览接口
  const base = birdRenderBase();
  const d = dir || BIRD_CUSTOM_DIR || "";
  let url = `${base}/api/bird_img?name=${encodeURIComponent(name)}`;
  if (d) url += `&dir=${encodeURIComponent(d)}`;
  return url;
}

/**
 * 拉取「小鸟昵称 -> 图片」的识别结果。
 *
 * 逐个昵称去素材目录里找 <昵称>.png，返回哪些找到了、哪些没有。
 */
async function loadBirdStatus() {
  const base = birdRenderBase();
  const dir = (BIRD_CUSTOM_DIR
               || (CONFIG && CONFIG.bird_image_dir) || "").trim();
  // 名字取「小鸟列表」里配的
  const rows = (DATA_COLLECTIONS && DATA_COLLECTIONS.bird_list) || [];
  const names = rows.map(r => (r && r.name || "").toString().trim())
                    .filter(Boolean);
  if (!names.length) {
    BIRD_STATUS = { dir: dir, resolved: {}, missing: [] };
    return BIRD_STATUS;
  }
  const url = `${base}/api/bird_resolve?names=${encodeURIComponent(names.join(","))}`
            + (dir ? `&dir=${encodeURIComponent(dir)}` : "");
  let firstErr = "";
  try {
    const resp = await fetch(url, { cache: "no-store" });
    const r = await resp.json();
    if (r && r.ok) {
      BIRD_STATUS = r;
      console.log(`[bird] 识别 ${r.count}/${names.length} 张，目录 ${r.dir}`);
      return r;
    }
    firstErr = (r && r.error) || `HTTP ${resp.status}`;
  } catch (e) {
    firstErr = `${e.name || "错误"}: ${e.message || e}`;
    console.warn("[bird] 直连渲染服务失败，改走插件桥接", url, e);
  }

  // ★ 兜底：走插件自己的同源路由（浏览器 -> AstrBot -> 渲染服务，
  //   完全不经跨域，渲染服务被防火墙/跨域策略挡住时仍然可用）
  for (const route of buildRouteUrls("birdResolve")) {
    try {
      const sep = route.includes("?") ? "&" : "?";
      const u2 = `${route}${sep}names=${encodeURIComponent(names.join(","))}`
               + (dir ? `&dir=${encodeURIComponent(dir)}` : "");
      const r2 = await tryFetchJSON(u2);
      if (r2 && r2.ok) {
        BIRD_STATUS = r2;
        console.log(`[bird] 同源识别 ${r2.count}/${names.length} 张（${route}）`);
        return r2;
      }
      if (r2 && r2.error) firstErr = r2.error;
    } catch (e2) {
      console.warn("[bird] 同源路由失败", route, e2);
    }
  }

  BIRD_STATUS = {
    dir: dir, resolved: {}, missing: names,
    error: `无法连接渲染服务：${url}\n${firstErr}`,
  };
  return BIRD_STATUS;
}

// ============================================================
// ★★ 1.7.7：银行冻结账号（后台查看 + 提前解冻）
// ------------------------------------------------------------
// 冻结是**按群**存的，所以一条冻结 = (群号, QQ)。后台可以看到所有
// 还在冻结中的账号，并能：① 点单条「解除」 ② 在输入框里填一堆
// QQ 号（英文逗号分隔）批量解除（该 QQ 在所有群的冻结全解）。
// ============================================================

/** 走插件自己的 /bankFrozen 路由（同源，不受跨域限制） */
async function bankFrozenCall(params) {
  const qs = new URLSearchParams(params || {}).toString();
  let lastErr = "";
  // ① 优先桥接（带超时）
  if (bridgeReady && bridge && typeof bridge.apiGet === "function") {
    try {
      const r = await Promise.race([
        bridge.apiGet(`bankFrozen${qs ? "?" + qs : ""}`),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("桥接超时")), 4000)),
      ]);
      if (r && r.ok !== false) return r;
      lastErr = (r && r.msg) || "桥接返回失败";
    } catch (e) {
      lastErr = `${e.name || "错误"}: ${e.message || e}`;
    }
  }
  // ② 兜底：同源 fetch
  for (const route of buildRouteUrls("bankFrozen")) {
    try {
      const u = qs ? `${route}${route.includes("?") ? "&" : "?"}${qs}` : route;
      const r = await tryFetchJSON(u);
      if (r && r.ok !== false) return r;
      lastErr = (r && r.msg) || "返回失败";
    } catch (e) {
      lastErr = `${e.name || "错误"}: ${e.message || e}`;
    }
  }
  throw new Error(lastErr || "无法连接插件");
}

/** 拉取冻结列表（不传参数 = 只查询） */
async function loadBankFrozen() {
  try {
    const r = await bankFrozenCall({});
    BANK_FROZEN = Array.isArray(r.frozen) ? r.frozen : [];
    BANK_FROZEN_ERR = "";
    console.log(`[bank] 冻结中 ${BANK_FROZEN.length} 个账号`);
  } catch (e) {
    BANK_FROZEN = [];
    BANK_FROZEN_ERR = `${e.name || "错误"}: ${e.message || e}`;
    console.warn("[bank] 读取冻结列表失败:", e);
  }
  return BANK_FROZEN;
}

/** 冻结账号面板 */
function buildBankFrozenHtml() {
  let inner = "";
  inner += `<div class="muted" style="margin-bottom:10px">
    这里列出**所有还在冻结中**的银行账号（抢银行失败惩罚）。
    <button class="btn btn-sm" data-action="bank-frozen-refresh"
            style="margin-left:8px">↻ 刷新</button>
  </div>`;
  if (BANK_FROZEN_ERR) {
    inner += `<div class="bird-status err">⚠️ 读取失败：${
      esc(BANK_FROZEN_ERR).replace(/\n/g, "<br>")}</div>`;
    return `<div class="bank-frozen-panel" data-bank-loaded="1">${inner}</div>`;
  }
  if (BANK_FROZEN === null) {
    inner += `<div class="muted">加载中…</div>`;
    return `<div class="bank-frozen-panel" data-bank-loaded="0">${inner}</div>`;
  }
  if (!BANK_FROZEN.length) {
    inner += `<div class="muted">🎉 当前没有账号被冻结</div>`;
    return `<div class="bank-frozen-panel" data-bank-loaded="1">${inner}</div>`;
  }
  inner += `<div class="muted small" style="margin-bottom:8px">
    共 <b style="color:#e57373">${BANK_FROZEN.length}</b> 个账号冻结中
  </div>`;
  inner += `<div class="bird-status-list">`;
  BANK_FROZEN.forEach((r) => {
    const gid = String((r && r.group_id) || "");
    const uid = String((r && r.user_id) || "");
    const nm = String((r && r.name) || "").trim() || `QQ${uid}`;
    const left = String((r && r.left_text) || "").trim() || "—";
    const until = String((r && r.until_text) || "").trim();
    inner += `<div class="bird-status-item miss">
      <div><b>${esc(nm)}</b>
        <span class="muted">（QQ ${esc(uid)}）</span></div>
      <div class="muted small">群 ${esc(gid)}　剩余 <b>${esc(left)}</b>${
        until ? `　解冻时间 ${esc(until)}` : ""}</div>
      <button class="btn btn-sm btn-danger" data-action="bank-unfreeze"
              data-gid="${esc(gid)}" data-qq="${esc(uid)}"
              style="margin-top:6px">🗑 解除冻结</button>
    </div>`;
  });
  inner += `</div>`;
  return `<div class="bank-frozen-panel" data-bank-loaded="1">${inner}</div>`;
}

/** 绑定冻结面板里的按钮 */
function bindBankFrozenActions() {
  document.querySelectorAll(
    "#content [data-action='bank-unfreeze'],"
    + "#content [data-action='bank-frozen-refresh'],"
    + "#content [data-action='bank-unfreeze-go']"
  ).forEach((btn) => {
    if (btn.dataset.bankBound) return;
    btn.dataset.bankBound = "1";
    btn.addEventListener("click", async () => {
      const act = btn.dataset.action;
      btn.disabled = true;
      try {
        if (act === "bank-frozen-refresh") {
          await loadBankFrozen();
          toast("已刷新冻结列表");
          render();
          return;
        }
        if (act === "bank-unfreeze-go") {
          const el = $("bankUnfreezeInput");
          const qq = (el && el.value || "").trim();
          if (!qq) { toast("请先填 QQ 号（多个用英文逗号分隔）", "error"); return; }
          const r = await bankFrozenCall({ qq: qq, clear: "1" });
          const n = parseInt(r.freed || 0) || 0;
          await loadBankFrozen();
          if (el) el.value = "";
          toast(n > 0 ? `✅ 已解冻 ${n} 条` : "⚠️ 没找到对应账号（可能未冻结/已过期）",
                n > 0 ? "success" : "error");
          render();
          return;
        }
        // 单条解除
        const gid = btn.dataset.gid || "";
        const qq = btn.dataset.qq || "";
        const r = await bankFrozenCall({ qq: qq, gid: gid });
        const n = parseInt(r.freed || 0) || 0;
        await loadBankFrozen();
        toast(n > 0 ? `✅ 已解除 QQ ${qq}` : "⚠️ 该账号已不在冻结中",
              n > 0 ? "success" : "error");
        render();
      } catch (e) {
        toast(`❌ 操作失败：${e.message || e}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/** 图片自动识别面板 */
function buildBirdStatusHtml() {
  const dir = (BIRD_CUSTOM_DIR
               || (CONFIG && CONFIG.bird_image_dir) || "（未设置）");
  const rows = (DATA_COLLECTIONS && DATA_COLLECTIONS.bird_list) || [];
  const st = BIRD_STATUS;
  let html = `<div class="muted" style="margin-bottom:10px">
    图片不用手动选 —— 填了小鸟昵称，就自动去目录里找同名图片：
    <code>${esc(dir)}</code> / <b>昵称</b>.png
    <button class="btn btn-sm" data-action="bird-status-refresh"
            style="margin-left:8px">↻ 重新识别</button>
  </div>`;
  if (!rows.length) {
    return html + `<div class="muted">还没有小鸟，先在下面「小鸟列表」里添加</div>`;
  }
  if (!st) {
    return html + `<div class="muted">识别中…</div>`;
  }
  if (st.error) {
    return html + `<div class="bird-status err">⚠️ ${
      esc(st.error).replace(/\n/g, "<br>")}</div>`;
  }
  const res = st.resolved || {};
  const miss = st.missing || [];
  html += `<div class="muted small" style="margin-bottom:8px">
    共 ${rows.length} 只，识别到 <b style="color:#4caf50">${Object.keys(res).length}</b> 张${
      miss.length ? `，缺失 <b style="color:#e57373">${miss.length}</b> 张` : ""}
  </div>`;
  html += `<div class="bird-status-list">`;
  rows.forEach((r, i) => {
    const nm = (r && r.name || "").toString().trim();
    if (!nm) return;
    const okFile = res[nm];
    const ok = !!okFile;
    html += `<div class="bird-status-item${ok ? "" : " miss"}">
      ${ok
        ? `<img src="${esc(birdPreviewUrl(okFile, st.dir))}" alt="" />`
        : `<span class="nopic">?</span>`}
      <div class="info">
        <div class="nm">${esc(nm)}</div>
        <div class="fn">${ok ? esc(okFile) : "未找到 " + esc(nm) + ".png"}</div>
      </div>
    </div>`;
  });
  html += `</div>`;
  if (miss.length) {
    html += `<div class="muted small" style="margin-top:8px">
      💡 把缺少的图片按「昵称.png」放进上面那个目录，再点「↻ 重新识别」即可
    </div>`;
  }
  return html;
}

/**
 * ★ 1.7.6：拉取「坐骑名 -> 图片」的识别结果。
 *
 * 和小鸟完全同一套逻辑：先直连渲染服务，失败再走插件同源路由。
 * 返回哪些坐骑找到了同名图、哪些还没配图。
 */
async function loadMountStatus() {
  // ★★ 1.1：**本版本已移除坐骑图片功能** —— 不再向任何渲染服务
  //   请求「坐骑名 -> 图片」识别结果（原来的 /api/mount_resolve）。
  //   保留函数是为了不打断既有调用点，直接返回空状态即可。
  MOUNT_STATUS = { dir: "", resolved: {}, missing: [], total: 0, count: 0 };
  return MOUNT_STATUS;
}

async function loadMountStatusLegacy() {
  // ★ 本版本已移除坐骑图片功能，此函数不再使用
  return null;
}

/** 坐骑素材预览图 URL */
function mountPreviewUrl(name, dir) {
  if (!name) return "";
  const base = birdRenderBase();
  const d = dir || MOUNT_CUSTOM_DIR || "";
  let url = `${base}/api/mount_img?name=${encodeURIComponent(name)}`;
  if (d) url += `&dir=${encodeURIComponent(d)}`;
  return url;
}

/** 坐骑图片自动识别面板 */
function buildMountStatusHtml() {
  const dir = (MOUNT_CUSTOM_DIR
               || (CONFIG && CONFIG.mount_img_dir) || "（未设置）");
  const rows = (DATA_COLLECTIONS && DATA_COLLECTIONS.mount_list) || [];
  const st = MOUNT_STATUS;
  let html = `<div class="muted" style="margin-bottom:10px">
    图片不用手动选 —— 填了坐骑名，就自动去目录里找同名图片：
    <code>${esc(dir)}</code> / <b>坐骑名</b>.png
    <button class="btn btn-sm" data-action="mount-status-refresh"
            style="margin-left:8px">↻ 重新识别</button>
  </div>`;
  if (!rows.length) {
    return html + `<div class="muted">还没有坐骑，先在下面「坐骑列表」里添加</div>`;
  }
  if (!st) {
    return html + `<div class="muted">识别中…</div>`;
  }
  if (st.error) {
    return html + `<div class="bird-status err">⚠️ ${
      esc(st.error).replace(/\n/g, "<br>")}</div>`;
  }
  const res = st.resolved || {};
  const miss = st.missing || [];
  const total = rows.length;
  const okN = Object.keys(res).length;
  html += `<div class="muted small" style="margin-bottom:8px">
    共 ${total} 个坐骑，识别到 <b style="color:#4caf50">${okN}</b> 张${
      miss.length ? `，缺失 <b style="color:#e57373">${miss.length}</b> 张` : " 🎉 全都有图"}
  </div>`;
  if (miss.length) {
    html += `<div class="bird-status err" style="margin-bottom:10px">
      ❌ 缺图的坐骑：${miss.map(esc).join("、")}
    </div>`;
  }
  html += `<div class="bird-status-list">`;
  rows.forEach((r) => {
    const nm = (r && r.name || "").toString().trim();
    if (!nm) return;
    const okFile = res[nm];
    const ok = !!okFile;
    html += `<div class="bird-status-item${ok ? "" : " miss"}">
      ${ok
        ? `<img src="${esc(mountPreviewUrl(okFile, st.dir))}" alt="" />`
        : `<span class="nopic">?</span>`}
      <div class="info">
        <div class="nm">${esc(nm)}</div>
        <div class="fn">${ok ? esc(okFile) : "未找到 " + esc(nm) + ".png"}</div>
      </div>
    </div>`;
  });
  html += `</div>`;
  if (miss.length) {
    html += `<div class="muted small" style="margin-top:8px">
      💡 把缺少的图片按「坐骑名.png」放进上面那个目录，再点「↻ 重新识别」即可
    </div>`;
  }
  return html;
}

/** 浏览某个目录（供「选择自定义目录」用） */
async function browseBirdDir(dir) {
  const base = birdRenderBase();
  const url = `${base}/api/bird_browse?dir=${encodeURIComponent(dir || "")}`;
  try {
    const resp = await fetch(url, { cache: "no-store" });
    const r = await resp.json();
    if (r && r.ok) {
      BIRD_BROWSE = r;
      console.log(`[bird] 浏览 ${r.dir}：${r.files.length} 图 / ${r.dirs.length} 目录`);
      return r;
    }
    toast(r && r.error ? r.error : "目录读取失败", "error");
  } catch (e) {
    console.warn("[bird] 浏览目录失败", url, e);
    toast("无法连接渲染服务（127.0.0.1:5099）", "error");
  }
  return null;
}

/**
 * 拉取小鸟素材文件列表。
 *
 * ★★ 1.1：**本版本已移除小鸟图鉴功能** —— 不再向任何渲染服务
 *   请求素材列表（原来的 /api/bird_files）。调用点保留，直接返回。
 */
async function loadBirdFiles() {
  BIRD_FILES = [];
  return false;
}

async function loadBirdFilesLegacy() {
  // ★ 本版本已移除小鸟图鉴功能，此函数不再使用
  return null;
}

/** 从配置里取「小鸟图片目录」（用户可能改过），供上面拼查询参数 */
let CURRENT_DIR_HINT = "";

const toastEl = $("toast");
function toast(msg, type = "success") {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = `toast toast-${type} show`;
  setTimeout(() => { toastEl.className = `toast toast-${type}`; }, 2200);
}

// ============================================================
// 自绘确认框（浏览器原生 confirm 在沙箱 iframe 里被禁用！）
// ------------------------------------------------------------
// ★ 插件页跑在 AstrBot 面板的沙箱 iframe 中，未设 allow-modals，
//   浏览器会拦截 confirm()/alert()/prompt()：
//     "Ignored call to 'confirm()'. The document is sandboxed,
//      and the 'allow-modals' keyword is not set."
//   被拦后 confirm() 返回 false，于是「点删除 -> 直接 return」，
//   表现为「删不掉、也没任何提示」。
//   所以这里用页面内自绘对话框替代，返回 Promise<boolean>。
// ============================================================
let _uiConfirmInited = false;

function _initConfirmStyles() {
  if (_uiConfirmInited) return;
  _uiConfirmInited = true;
  const st = document.createElement("style");
  st.textContent = `
.ui-confirm-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;z-index:99999;}
.ui-confirm-box{min-width:280px;max-width:min(560px,92vw);
  background:#232733;color:#eef1f7;border:1px solid #3b4152;
  border-radius:12px;padding:18px 18px 14px;
  box-shadow:0 18px 48px rgba(0,0,0,.55);font-size:14px;line-height:1.6;}
.ui-confirm-msg{white-space:pre-wrap;word-break:break-word;}
.ui-confirm-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}
.ui-confirm-btns button{border-radius:8px;padding:7px 16px;font-size:14px;
  cursor:pointer;border:1px solid #4a5164;background:#2c3140;color:#eef1f7;}
.ui-confirm-btns button:hover{filter:brightness(1.15);}
.ui-confirm-btns button.ok{background:#d9534f;border-color:#d9534f;color:#fff;}
.ui-confirm-ok.safe{background:#2f7d4f;border-color:#2f7d4f;}
`;
  document.head.appendChild(st);
}

/**
 * 页面内确认框。用法：if (!await uiConfirm("确定删除？")) return;
 * opts.okText / opts.cancelText 可自定义按钮文字。
 */
function uiConfirm(message, opts = {}) {
  _initConfirmStyles();
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ui-confirm-mask";
    const box = document.createElement("div");
    box.className = "ui-confirm-box";
    const msg = document.createElement("div");
    msg.className = "ui-confirm-msg";
    msg.textContent = String(message == null ? "" : message);
    const btns = document.createElement("div");
    btns.className = "ui-confirm-btns";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = opts.cancelText || "取消";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ui-confirm-ok" +
      (opts.danger === false ? " safe" : "");
    ok.textContent = opts.okText || "确定";

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { mask.remove(); } catch (e) { /* 忽略 */ }
      resolve(v);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    mask.addEventListener("click", (e) => {
      if (e.target === mask) finish(false);      // 点遮罩 = 取消
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter") finish(true);
    });

    btns.appendChild(cancel);
    btns.appendChild(ok);
    box.appendChild(msg);
    box.appendChild(btns);
    mask.appendChild(box);
    document.body.appendChild(mask);
    try { ok.focus(); } catch (e) { /* 忽略 */ }
  });
}

// ============================================================
// 桥接初始化（带超时保护，防止 bridge.ready() 永远挂住）
// ============================================================
async function initBridge(retries = 2, timeoutMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      if (!bridge || typeof bridge.ready !== "function") {
        throw new Error("AstrBotPluginPage 不存在或缺少 ready()");
      }
      console.log(`[bridge] ready 第 ${i + 1}/${retries} 次尝试`);
      await Promise.race([
        bridge.ready(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`bridge.ready() 超时（${timeoutMs}ms）`)), timeoutMs)
        ),
      ]);
      bridgeReady = true;
      const el = $("bridgeStatus");
      if (el) {
        el.textContent = "桥接已就绪";
        el.className = "bridge-status ok";
      }
      console.log("[bridge] ready 成功");
      return true;
    } catch (e) {
      console.warn(`[bridge] ready 失败 (${i + 1}/${retries}):`, e);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  bridgeReady = false;
  const el = $("bridgeStatus");
  if (el) {
    el.textContent = "桥接不可用（降级 fetch）";
    el.className = "bridge-status fail";
  }
  console.warn("[bridge] 已放弃，使用 fetch 降级");
  return false;
}

// ============================================================
// 通用请求工具
// ============================================================
async function tryFetchJSON(url, options = {}) {
  const r = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${url}`);
  }
  return await r.json();
}

// 配置接口候选 URL（GET / POST 共用）
// 后端通过 context.register_web_api 注册的路由是 /<PLUGIN_ID>/<action>，
// 在 AstrBot 面板中经 /api/plug/ 分发命中；因此兜底只能用这一种形态。
// 写操作请求头：配置了访问令牌时自动携带 X-Plugin-Token
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  try {
    const tk = (CONFIG && CONFIG.web_admin_token) || "";
    if (tk) h["X-Plugin-Token"] = tk;
  } catch (e) { /* 忽略 */ }
  return h;
}

function buildRouteUrls(action) {
  return [
    `/${PLUGIN_ID}/${action}`,                     // 直接命中注册路由
    `/api/plug/${PLUGIN_ID}/${action}`,            // 经面板插件扩展入口分发
  ];
}

function buildConfigUrls() {
  return buildRouteUrls("config");
}

// ============================================================
// 配置加载（桥接优先 + 超时 + fetch 兜底）
// ============================================================
async function loadAllConfig() {
  const errors = [];

  // ---------- 优先 bridge.apiGet（带超时）----------
  if (bridgeReady && bridge && typeof bridge.apiGet === "function") {
    try {
      console.log(`[config] bridge.apiGet("config")`);
      const res = await Promise.race([
        bridge.apiGet("config"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("bridge.apiGet 超时（2000ms）")), 2000)
        ),
      ]);
      console.log(`[config] bridge.apiGet("config") 返回:`, res);
      if (res && (res.schema || res.config)) {
        SCHEMA = res.schema || {};
        CONFIG = res.config || {};
        console.log(`[config] 桥接成功: schema=${Object.keys(SCHEMA).length}, config=${Object.keys(CONFIG).length}`);
        return true;
      }
      errors.push(`bridge.apiGet("config") 返回空`);
    } catch (e) {
      console.warn(`[config] bridge.apiGet("config") 失败:`, e);
      errors.push(`bridge.apiGet("config"): ${e.message || e}`);
    }
  } else {
    errors.push("桥接不可用");
  }

  // ---------- 兜底：同源 fetch ----------
  for (const url of buildConfigUrls()) {
    try {
      console.log(`[config] fetch GET ${url}`);
      const j = await tryFetchJSON(url);
      if (j && (j.schema || j.config)) {
        SCHEMA = j.schema || {};
        CONFIG = j.config || {};
        console.log(`[config] fetch GET 成功: schema=${Object.keys(SCHEMA).length}, config=${Object.keys(CONFIG).length}`);
        return true;
      }
    } catch (e) {
      console.warn(`[config] fetch GET ${url} 失败:`, e);
      errors.push(`${url}: ${e.message || e}`);
    }
  }

  console.error("[config] 全部失败:", errors);
  const errEl = $("errorMsg");
  if (errEl) errEl.innerHTML = errors.map(e => `· ${esc(e)}`).join("<br>");
  return false;
}

// ============================================================
// 保存结果判定
// 后端统一返回 {ok: bool, msg: string, config?: {...}}
//   返回 true  -> 已确定结果（成功）
//   返回 false -> 已确定结果（失败，并已提示）
//   返回 null  -> 本次尝试没有明确结论，可换 URL / 传参形态重试
// ============================================================
function applySaveResult(res, tag) {
  if (!res || typeof res !== "object") return null;
  if (res.ok === true) {
    console.log(`[config] ✅ 保存成功（${tag}）`);
    return true;
  }
  if (res.ok === false) {
    const msg = res.msg || "未知错误";
    console.warn(`[config] ⚠️ 后端拒绝（${tag}）：${msg}`);
    // "数据为空" 说明本次传参形态没被识别，交给下一种形态重试
    if (msg === "数据为空") return null;
    toast(`保存失败：${msg}`, "error");
    return false;
  }
  console.warn(`[config] 响应缺少 ok 字段（${tag}），视为未确认`);
  return null;
}

// ============================================================
// 配置保存（桥接优先 + 超时 + fetch 兜底）
// ============================================================
async function saveConfig(partial) {
  CONFIG = Object.assign({}, CONFIG, partial);

  // ---------- ① 优先桥接：直接传配置体 ----------
  if (bridgeReady && bridge && typeof bridge.apiPost === "function") {
    const attempts = [
      { desc: 'apiPost("config", payload)',           fn: () => bridge.apiPost("config", partial) },
      { desc: 'apiPost("config", {data: payload})',   fn: () => bridge.apiPost("config", { data: partial }) },
      { desc: 'apiPost("saveConfig", payload)',       fn: () => bridge.apiPost("saveConfig", partial) },
    ];

    for (const at of attempts) {
      try {
        console.log(`[config] bridge.${at.desc}`);
        const res = await Promise.race([
          at.fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`bridge.${at.desc} 超时`)), 2000)
          ),
        ]);
        console.log(`[config] bridge.${at.desc} 返回:`, res);

        const settled = applySaveResult(res, `bridge.${at.desc}`);
        if (settled !== null) return settled;
      } catch (e) {
        console.warn(`[config] bridge.${at.desc} 异常:`, e);
      }
    }
  } else {
    console.warn("[config] 桥接不可用，跳过 bridge.apiPost");
  }

  // ---------- ② 兜底：同源 fetch ----------
  for (const url of buildConfigUrls()) {
    try {
      console.log(`[config] fetch POST ${url}`, partial);
      const r = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(partial),
      });
      if (!r.ok) {
        console.warn(`[config] fetch POST ${url} HTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      console.log(`[config] fetch POST ${url} 返回:`, j);
      const settled = applySaveResult(j, `fetch ${url}`);
      if (settled !== null) return settled;
    } catch (e) {
      console.warn(`[config] fetch POST ${url} 失败:`, e);
    }
  }

  toast("保存失败，请查看控制台日志", "error");
  return false;
}

// ============================================================
// Schema 取值辅助
// ============================================================
function cfgVal(key) {
  if (key in CONFIG) return CONFIG[key];
  const s = SCHEMA[key];
  return s && "default" in s ? s.default : "";
}
function cfgDesc(key) { return (SCHEMA[key] && SCHEMA[key].description) || key; }
function cfgHint(key) { return (SCHEMA[key] && SCHEMA[key].hint) || ""; }

// ============================================================
// 通用控件渲染
// ============================================================
function renderBool(key) {
  const on = !!cfgVal(key);
  return `<div class="switch-row">
    <div>
      <div class="switch-label">${esc(cfgDesc(key))}</div>
      ${cfgHint(key) ? `<div class="switch-desc">${esc(cfgHint(key))}</div>` : ""}
    </div>
    <label class="switch">
      <input type="checkbox" data-cfg="${key}" data-type="bool" ${on ? "checked" : ""} />
      <span class="slider"></span>
    </label>
  </div>`;
}

function renderString(key, opts = {}) {
  const v = cfgVal(key);
  const common = `data-cfg="${key}" data-type="string"`;
  const input = opts.textarea
    ? `<textarea ${common} rows="3">${esc(v)}</textarea>`
    : `<input type="text" ${common} value="${esc(v)}" />`;
  return `<div class="form-group">
    <label>${esc(cfgDesc(key))}</label>
    ${input}
    ${cfgHint(key) ? `<span class="hint">${esc(cfgHint(key))}</span>` : ""}
  </div>`;
}

// 枚举配置项：渲染成下拉（SCHEMA.options / SCHEMA.labels）
function renderEnum(key) {
  const schema = SCHEMA[key] || {};
  const opts = Array.isArray(schema.options) ? schema.options.map(String) : [];
  const labels = Array.isArray(schema.labels) ? schema.labels : [];
  const cur = String(cfgVal(key) ?? "");
  let sel = "";
  opts.forEach((o, i) => {
    const text = labels[i] ? `${labels[i]}` : o;
    sel += `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(text)}</option>`;
  });
  // 当前值不在选项里（如手填过）也保留，避免保存时被清掉
  if (cur && !opts.includes(cur)) {
    sel += `<option value="${esc(cur)}" selected>${esc(cur)}（当前值）</option>`;
  }
  return `<div class="form-group">
    <label>${esc(cfgDesc(key))}</label>
    <select data-cfg="${key}" data-type="string">${sel}</select>
    ${cfgHint(key) ? `<span class="hint">${esc(cfgHint(key))}</span>` : ""}
  </div>`;
}


// 背景图选择器：下拉（带文字）+ 可视化缩略图卡片
function renderBgPicker(key) {
  const schema = SCHEMA[key] || {};
  const opts = Array.isArray(schema.options) ? schema.options.map(String) : [];
  const labels = Array.isArray(schema.labels) ? schema.labels : [];
  const cur = String(cfgVal(key) ?? "");
  // 渲染服务地址（用于取缩略图）
  const base = String(cfgVal("output_render_base") || "http://127.0.0.1:5099").replace(/\/$/, "");

  // 下拉（保留一个可键盘操作的入口）
  let sel = "";
  opts.forEach((o, i) => {
    const text = labels[i] ? `${labels[i]}` : o;
    sel += `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(text)}</option>`;
  });
  if (cur && !opts.includes(cur)) {
    sel += `<option value="${esc(cur)}" selected>${esc(cur)}（当前值）</option>`;
  }

  // 缩略图卡片
  let cards = "";
  opts.forEach((o, i) => {
    const active = o === cur ? " active" : "";
    const url = `${base}/api/bg_preview?name=${encodeURIComponent(o)}`;
    const text = labels[i] ? labels[i] : o;
    cards += `<div class="bg-option${active}" data-cfg-pick="${key}" data-value="${esc(o)}" title="${esc(text)}">
      <img src="${esc(url)}" alt="${esc(text)}" loading="lazy" />
      <div class="bg-option-label">${esc(text)}</div>
    </div>`;
  });

  return `<div class="form-group bg-picker" data-bgkey="${key}">
    <label>${esc(cfgDesc(key))}</label>
    <select data-cfg="${key}" data-type="string" class="bg-select">${sel}</select>
    <div class="bg-options">${cards}</div>
    ${cfgHint(key) ? `<span class="hint">${esc(cfgHint(key))}</span>` : ""}
  </div>`;
}


// 纯说明段落（不可编辑，只展示文字）
function renderParagraph(text) {
  if (!text) return "";
  const lines = String(text).split("\n");
  return `<div class="paragraph">${lines.map(l => esc(l)).join("<br>")}</div>`;
}


// 背景卡片点击 -> 选中（同步下拉与高亮）
function bindBgPicker() {
  document.querySelectorAll("[data-cfg-pick]").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-cfg-pick");
      const val = el.getAttribute("data-value") || "";
      CONFIG[key] = val;
      // 同步本组高亮
      const wrap = el.closest(".bg-picker");
      if (wrap) {
        wrap.querySelectorAll(".bg-option").forEach(o => o.classList.remove("active"));
        wrap.querySelectorAll(".bg-option").forEach(o => {
          if ((o.getAttribute("data-value") || "") === val) o.classList.add("active");
        });
        const sel = wrap.querySelector("select[data-cfg]");
        if (sel) sel.value = val;
      }
      if (typeof markDirtyHint === "function") markDirtyHint();
    });
  });
}


function renderInt(key) {
  const v = cfgVal(key);
  return `<div class="form-group">
    <label>${esc(cfgDesc(key))}</label>
    <input type="number" data-cfg="${key}" data-type="int" value="${esc(v)}" />
    ${cfgHint(key) ? `<span class="hint">${esc(cfgHint(key))}</span>` : ""}
  </div>`;
}

function renderTemplateList(key) {
  const items = Array.isArray(cfgVal(key)) ? cfgVal(key) : [];
  const schema = SCHEMA[key] || {};
  const templates = schema.templates || {};
  const tplKey = Object.keys(templates)[0] || "";
  const tpl = templates[tplKey] || { items: {} };
  const fields = Object.entries(tpl.items || {});

  let html = `<div class="template-list" data-tplkey="${key}">`;
  items.forEach((item, idx) => {
    html += `<div class="template-item" data-idx="${idx}">`;
    html += `<div class="template-item-header">
      <div class="template-item-title">${esc(tpl.name || tplKey)} #${idx + 1}</div>
      <button class="btn btn-sm btn-danger" data-action="del-tpl" data-key="${key}" data-idx="${idx}">删除</button>
    </div>`;
    html += `<div class="template-item-body">`;
    fields.forEach(([fk, fs]) => {
      const label = fs.description || fk;
      const ftype = fs.type || "string";
      const fval = item[fk] != null ? item[fk] : (fs.default || "");
      const dataAttr = `data-tplkey="${key}" data-idx="${idx}" data-field="${fk}" data-ftype="${ftype}"`;
      const opts = Array.isArray(fs.options) ? fs.options : null;
      if (opts && opts.length) {
        // 枚举字段渲染成下拉，避免手填错
        let sel = `<option value=""></option>`;
        const known = opts.map(String);
        const extra = (fval && !known.includes(String(fval))) ? [String(fval)] : [];
        known.concat(extra).forEach(o => {
          sel += `<option value="${esc(o)}"${String(o) === String(fval) ? " selected" : ""}>${esc(o)}</option>`;
        });
        html += `<div class="form-row"><div class="form-group">
          <label>${esc(label)}</label>
          <select ${dataAttr}>${sel}</select>
        </div></div>`;
      } else if (ftype === "text") {
        html += `<div class="form-row"><div class="form-group">
          <label>${esc(label)}</label>
          <textarea ${dataAttr} rows="2">${esc(fval)}</textarea>
        </div></div>`;
      } else {
        html += `<div class="form-row"><div class="form-group">
          <label>${esc(label)}</label>
          <input type="text" ${dataAttr} value="${esc(fval)}" />
        </div></div>`;
      }
    });
    html += `</div></div>`;
  });
  html += `</div>`;
  html += `<button class="btn btn-primary btn-sm" data-action="add-tpl" data-key="${key}" style="margin-top:10px;">+ 添加条目</button>`;
  return html;
}

// ============================================================
// 数据管理（1.7.2）
//   数据类内容（接口规则/图鉴/事件/词库/坐骑/工种/文案/运势…）
//   存在独立数据文件里，这里做增删改。
//   ★ 与 app.js 同一模块作用域，可直接用 esc/toast/bridge 等
// ============================================================

// 各集合的字段定义（顺序即表单顺序；options 会渲染成下拉）
const DATA_FIELDS = {
  api_list: [
    { key: "keywords", label: "关键词（多个用英文逗号分隔）", type: "string" },
    { key: "url_template", label: "URL 模板（无参数接口直接填完整地址）", type: "string" },
    { key: "param_count", label: "参数个数", type: "select", options: ["0", "1", "2"] },
    { key: "media_type", label: "返回类型", type: "select", options: ["image", "video", "text"] },
    { key: "json_field", label: "JSON 字段（如 data.video / content）", type: "string" },
  ],
  fortune_list: [
    { key: "fortune", label: "运势", type: "string" },
    { key: "stars", label: "星级", type: "string" },
    { key: "title", label: "签文", type: "string" },
    { key: "desc", label: "解签", type: "text" },
  ],
  word_reply_list: [
    { key: "keywords", label: "关键词（多个用英文逗号分隔）", type: "string" },
    { key: "reply", label: "回复内容", type: "text" },
  ],
  // ★★ 1.7.8：戳一戳随机回复词库（一条一个词，随机抽）
  poke_reply_list: [
    { key: "word", label: "回复词（一条一句，随机抽）", type: "text" },
  ],
  mount_list: [
    { key: "name", label: "坐骑名", type: "string" },
    { key: "price", label: "价格（积分）", type: "string" },
    { key: "desc", label: "描述", type: "text" },
    // ★★ 1.7.6：坐骑附加 BUFF（偷积分 / 抢银行成功率加成，单位 %）
    //   · 只在「坐骑查看」里显示
    //   · 留空 = 按价格自动算默认值；填 0 = 该坐骑不加成
    { key: "steal_bonus", label: "偷积分加成（%，留空按价格自动）",
      type: "string" },
    { key: "rob_bonus", label: "抢银行加成（%，留空按价格自动）",
      type: "string" },
  ],
  job_list: [
    { key: "name", label: "工种名", type: "string" },
    { key: "duration_hours", label: "耗时（小时）", type: "string" },
    { key: "reward_min", label: "奖励下限", type: "string" },
    { key: "reward_max", label: "奖励上限", type: "string" },
  ],
  // ★★ 1.7.6 新增：签到商店（保险箱 / 武器）
  shop_list: [
    { key: "name", label: "商品名", type: "string" },
    { key: "price", label: "价格（积分）", type: "string" },
    { key: "kind", label: "类型（vault=保险箱 / weapon=武器 / food=食物）",
      type: "string" },
    { key: "desc", label: "描述", type: "text" },
    { key: "steal_bonus", label: "偷积分加成（%，仅武器）",
      type: "string" },
    { key: "defense_bonus", label: "防被偷加成（%，仅武器）",
      type: "string" },
    { key: "vault_break_rate",
      label: "破保险箱概率（%，仅武器；留空用全局）", type: "string" },
    { key: "stamina_restore",
      label: "恢复体力（仅 kind=food；留空用全局默认）", type: "string" },
  ],
  greeting_morning_messages: [
    { key: "start_hour", label: "起始小时（0-23）", type: "string" },
    { key: "end_hour", label: "结束小时（1-24）", type: "string" },
    { key: "message", label: "早安文案", type: "text" },
  ],
  greeting_night_messages: [
    { key: "start_hour", label: "起始小时（0-23）", type: "string" },
    { key: "end_hour", label: "结束小时（1-24）", type: "string" },
    { key: "message", label: "晚安文案", type: "text" },
  ],
  bird_list: [
    // ★ 图片不用填：按「小鸟名字」自动去素材目录里找 <名字>.png
    // ★ name 就是「中文名」，图鉴详情里不再重复显示一遍名字
    { key: "name", label: "中文名（图片名要跟它一致）", type: "string" },
    { key: "en", label: "英文名", type: "string" },
    { key: "protect", label: "保护等级", type: "string" },
    { key: "desc", label: "简介", type: "text" },
  ],
  pet_list: [
    { key: "name", label: "宠物名字", type: "string" },
    { key: "desc", label: "介绍", type: "text" },
    { key: "price", label: "价格（积分）", type: "string" },
    // 五行由系统按顺序自动分配，不在后台编辑（属性一律购买后随机生成）
  ],
  pet_adventure_events: [
    { key: "event", label: "事件描述", type: "string" },
    { key: "exp_min", label: "经验下限", type: "string" },
    { key: "exp_max", label: "经验上限", type: "string" },
    { key: "score_min", label: "积分下限", type: "string" },
    { key: "score_max", label: "积分上限", type: "string" },
    { key: "hp_cost", label: "额外掉血", type: "string" },
  ],
  pet_work_events: [
    { key: "event", label: "事件描述", type: "string" },
    { key: "exp_min", label: "经验下限", type: "string" },
    { key: "exp_max", label: "经验上限", type: "string" },
    { key: "score_min", label: "积分下限", type: "string" },
    { key: "score_max", label: "积分上限", type: "string" },
  ],
  pet_item_list: [
    { key: "name", label: "物品名字", type: "string" },
    { key: "price", label: "价格（积分）", type: "string" },
    { key: "kind", label: "类型", type: "select", options: ["hp", "mp"] },
    { key: "value", label: "恢复数值", type: "string" },
    { key: "desc", label: "介绍", type: "text" },
  ],
  // ★ 菜单输出内容：每个菜单一条，text 就是群里发出来的内容
  //   空 = 用系统默认（改坏了清空即可恢复）
  //   version = 生成这份默认文案时的代码版本；插件升级后会自动
  //             把「没被自定义过」的旧文案重生成，见 main._init_menu_texts
  menu_texts: [
    { key: "id", label: "菜单标识（别改）", type: "string" },
    { key: "label", label: "菜单名", type: "string" },
    { key: "text", label: "菜单输出内容（清空=恢复默认）", type: "text" },
    { key: "version", label: "内容版本（别改）", type: "string" },
  ],
};

// 集合的中文名（用于选择器）
const DATA_LABELS = {
  api_list: "接口规则",
  fortune_list: "今日运势内容",
  word_reply_list: "自定义词库",
  mount_list: "坐骑列表",
  job_list: "工种列表",
  shop_list: "签到商店",
  greeting_morning_messages: "早安文案",
  greeting_night_messages: "晚安文案",
  pet_list: "宠物图鉴",
  pet_work_events: "宠物上班事件",
  pet_adventure_events: "宠物冒险事件",
  pet_item_list: "物品商店",
  bird_list: "小鸟列表",
  menu_texts: "菜单输出内容",
};

const DATA_COLLECTIONS = {};   // {key: [rows]}（始终原地更新，避免引用失效）
// ★★ 市场版 1.1：机器人数据统计（/data 接口一起返回）
let BOT_STATS = null;
function applyCollections(cols) {
  if (!cols || typeof cols !== "object") return false;
  Object.keys(DATA_COLLECTIONS).forEach(k => { delete DATA_COLLECTIONS[k]; });
  Object.keys(cols).forEach(k => { DATA_COLLECTIONS[k] = cols[k]; });
  console.log(`[data] 已载入 ${Object.keys(DATA_COLLECTIONS).length} 组数据`);
  return true;
}
let DATA_CURRENT = "";       // 当前选中的集合
// ★ 便于在浏览器控制台排查（只读用法）：window.__dshData.COLLECTIONS 等
try {
  window.__dshData = {
    get COLLECTIONS() { return DATA_COLLECTIONS; },
    get CURRENT() { return DATA_CURRENT; },
    get DIRTY() { return DATA_DIRTY; },
    get VIEWS() { return DATA_VIEWS; },
  };
} catch (e) { /* 忽略 */ }
let DATA_DIRTY = false;      // 有未保存改动
const DATA_REMEMBER = {};    // 各视图上次选中的列表（避免来回切视图被重置）

function dataCollectionKeys() {
  const keys = Object.keys(DATA_COLLECTIONS);
  // 按 DATA_FIELDS 的声明顺序排，未声明的排后面
  const known = Object.keys(DATA_FIELDS).filter(k => keys.includes(k));
  const rest = keys.filter(k => !known.includes(k));
  return known.concat(rest);
}

/** 可用于按钮条的全部条目（含接口类型的虚拟视图） */
function dataViewKeys() {
  return dataCollectionKeys();
}

/** 该视图的条目是否可用（虚拟视图看它背后的集合是否存在） */
function viewAvailable(view) {
  const keys = Object.keys(DATA_COLLECTIONS);
  return DATA_VIEWS[view] ? keys.includes(DATA_VIEWS[view].collection)
                          : keys.includes(view);
}

async function loadCollections() {
  // 桥接优先（与其余配置读写走同一套通道）
  if (bridgeReady && bridge && typeof bridge.apiGet === "function") {
    try {
      const res = await Promise.race([
        bridge.apiGet("data"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("bridge.apiGet(\"data\") 超时")), 4000)),
      ]);
      if (res && res.collections) {
        applyCollections(res.collections);
        if (res.botStats) BOT_STATS = res.botStats;
        return true;
      }
      console.warn("[data] bridge.apiGet(\"data\") 返回异常:", res);
    } catch (e) {
      console.warn("[data] bridge.apiGet(\"data\") 失败:", e);
    }
  }
  // 兜底：同源 fetch
  for (const url of buildRouteUrls("data")) {
    try {
      const j = await tryFetchJSON(url);
      if (j && j.collections) {
        applyCollections(j.collections);
        if (j.botStats) BOT_STATS = j.botStats;
        return true;
      }
    } catch (e) {
      console.warn(`[data] fetch GET ${url} 失败:`, e);
    }
  }
  toast("数据加载失败，请刷新页面重试", "error");
  return false;
}

async function saveCollection(key, rows) {
  const payload = { action: "set", key: key, rows: rows };
  const headers = authHeaders({ "Content-Type": "application/json" });
  let lastMsg = "";
  if (!key) {
    console.error("[data] saveCollection 收到空集合名，已拦截", payload);
    toast("保存失败：集合名为空（页面状态异常），请刷新页面重试", "error");
    return false;
  }
  console.log(`[data] 保存集合 ${key}，共 ${rows.length} 条`);

  if (bridgeReady && bridge && typeof bridge.apiPost === "function") {
    try {
      const res = await Promise.race([
        bridge.apiPost("data", payload),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("bridge.apiPost(\"data\") 超时")), 6000)),
      ]);
      if (res && !res.ok) lastMsg = backendMsg(res);
      if (res && res.ok) {
        if (res.collections) applyCollections(res.collections);
        return true;
      }
      toast(`保存失败：${backendMsg(res) || "未知错误"}`, "error");
      return false;
    } catch (e) {
      console.warn("[data] bridge.apiPost(\"data\") 失败:", e);
    }
  }
  // 兜底：同源 fetch。注意插件页跑在沙箱 iframe 里（origin 为 null），
  // 直连基本都会被 CORS 拦掉，因此这里只静默试一次，不再刷红色报错。
  const urls = buildRouteUrls("data").slice(0, 1);
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: headers, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j && !j.ok) lastMsg = backendMsg(j);
      if (j && j.ok) {
        if (j.collections) applyCollections(j.collections);
        return true;
      }
      if (j && j.ok === false && backendMsg(j)) {
        toast(`保存失败：${backendMsg(j)}`, "error");
        return false;
      }
    } catch (e) {
      // 沙箱 iframe 下属预期失败，仅调试级别
      console.debug(`[data] fetch 兜底 ${url} 不可用（预期）:`, e && e.message);
    }
  }

  // ---------- ② 同源 POST /dataOp（不依赖桥接，大 payload 也支持）----------
  for (const url of buildRouteUrls("dataOp")) {
    try {
      console.log(`[data] fetch POST ${url}（dataOp）`);
      const r = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j && j.ok) {
        if (j.rows) {
          DATA_COLLECTIONS[key] = j.rows;
        } else if (j.collections) {
          applyCollections(j.collections);
        }
        console.log(`[data] /dataOp 保存成功：${key} -> ${j.count} 条`);
        return true;
      }
      if (j && j.msg) lastMsg = j.msg;
    } catch (e) {
      console.debug(`[data] POST ${url} 不可用:`, e && e.message);
    }
  }

  // ---------- ③ GET /dataOp?op=set（最终兜底；payload 过大时会失败）----------
  try {
    const qs = new URLSearchParams({
      key: key,
      op: "set",
      rows: JSON.stringify(rows),
    });
    const tk = (CONFIG && CONFIG.web_admin_token) || "";
    if (tk) qs.set("token", tk);
    for (const url of buildRouteUrls("dataOp")) {
      try {
        const r = await fetch(`${url}?${qs.toString()}`, { method: "GET" });
        const j = await r.json();
        if (j && j.ok) {
          if (j.rows) DATA_COLLECTIONS[key] = j.rows;
          console.log(`[data] GET /dataOp 保存成功：${key} -> ${j.count} 条`);
          return true;
        }
        if (j && j.msg) lastMsg = j.msg;
      } catch (e) {
        console.debug(`[data] GET ${url} 不可用:`, e && e.message);
      }
    }
  } catch (e) {
    console.debug("[data] GET /dataOp 构造失败:", e && e.message);
  }

  // ★ 关键：把失败**明确显示出来**，不再静默
  const msg = lastMsg || "接口未响应（桥接/直连都失败）";
  console.error(`[data] 保存 ${key} 失败：${msg}`);
  toast(`❌ 保存「${key}」失败：${msg}（改动未写入，请勿关闭页面后重试）`,
        "error");
  return false;
}

function dataFieldValue(row, fk) {
  const v = row ? row[fk] : undefined;
  return v == null ? "" : String(v);
}

// 每个数据组在独立页面左侧对应一个按钮（按功能归组）
const DATA_GROUPS = [
  { title: "接口系统", keys: ["api_image", "api_video", "api_text"] },
  { title: "打卡系统", keys: ["greeting_morning_messages", "greeting_night_messages"] },
  { title: "每日系列", keys: ["fortune_list"] },
  { title: "词库系统", keys: ["word_reply_list"] },
  // ★★ 1.7.8：戳一戳回复词库（独立页面也有入口，这里方便单独管理）
  { title: "戳一戳回复", keys: ["poke_reply_list"] },
  { title: "签到系统", keys: ["mount_list", "job_list", "shop_list"] },
  { title: "宠物功能", keys: ["pet_list", "pet_work_events",
        "pet_adventure_events", "pet_item_list"] },
];

// 接口规则是同一份数据，按「返回类型」拆成三个按钮（无需分开存储）
const DATA_VIEWS = {
  "api_image": { collection: "api_list", filterField: "media_type",
                 filterAny: ["", "image"], matchEmpty: true, icon: "🖼",
                 label: "图片接口", empty: "暂无图片类接口" },
  "api_video": { collection: "api_list", filterField: "media_type",
                 filterValue: "video", icon: "🎬", label: "视频接口",
                 empty: "暂无视频类接口" },
  "api_text":  { collection: "api_list", filterField: "media_type",
                 filterValue: "text", icon: "📝", label: "文本接口",
                 empty: "暂无文本类接口" },
  // ★★ 1.7.7：签到商店按类型拆视图 —— 食物 / 武器 / 保险箱 分开看，
  //   这样「食物」不会被埋在武器后面（用户反馈在第 2 页找不到）。
  "shop_food":   { collection: "shop_list", filterField: "kind",
                   filterValue: "food", icon: "🍖", label: "食物（恢复体力）",
                   empty: "暂无食物。新增一条，把「类型」填 food 即可" },
  "shop_weapon": { collection: "shop_list", filterField: "kind",
                   filterAny: ["", "weapon"], matchEmpty: true, icon: "⚔️",
                   label: "武器", empty: "暂无武器" },
  "shop_vault":  { collection: "shop_list", filterField: "kind",
                   filterValue: "vault", icon: "🧰", label: "保险箱",
                   empty: "暂无保险箱" },
};

/** 某个数据视图对应的真实集合键 */
/**
 * 解析「当前要保存的集合 key」，带兜底与诊断。
 * 之前这里直接 viewCollection(DATA_CURRENT)，DATA_CURRENT 为空时会向后端
 * 发一个空 key，后端只能回 400「未知集合：」——错误信息完全看不出原因。
 */
function currentCollectionKey() {
  let k = viewCollection(DATA_CURRENT);
  if (k) return k;
  // 兜底 1：当前视图本身若就是一个真实集合名，直接用
  if (DATA_CURRENT && DATA_COLLECTIONS[DATA_CURRENT]) return DATA_CURRENT;
  // 兜底 2：取第一个可用集合
  const keys = dataCollectionKeys();
  if (keys.length) {
    console.warn(`[data] DATA_CURRENT 异常(${JSON.stringify(DATA_CURRENT)})，`
      + `已兜底为 ${keys[0]}`);
    DATA_CURRENT = keys[0];
    return keys[0];
  }
  console.error("[data] 无法确定集合：DATA_CURRENT=", DATA_CURRENT,
    "DATA_COLLECTIONS=", Object.keys(DATA_COLLECTIONS));
  return "";
}

/** 当前正在编辑的容器（唯一编辑器即它本身） */
function currentEditorEl() {
  const eds = document.querySelectorAll("#content .section[data-coll-view]");
  if (!eds.length) return null;
  for (const ed of eds) {
    if (ed.querySelector('[data-action="data-add"]')) return ed;
  }
  return eds[0];
}

/** 某个编辑器对应的视图名 */
function editorView(el) {
  const fromEl = el && el.getAttribute
    ? String(el.getAttribute("data-coll-view") || "") : "";
  if (fromEl) return fromEl;
  return String(DATA_CURRENT || "");
}

/** 某个编辑器对应的真实集合名 */
function editorCollection(el) {
  return viewCollection(editorView(el));
}

/** 取某个编辑器内的条目元素（只取直属它的，避免嵌套时串台） */
function editorItems(el) {
  const out = [];
  if (!el) return out;
  el.querySelectorAll(".data-item").forEach(item => {
    if (item.closest(".section[data-coll-view]") !== el) return;
    out.push(item);
  });
  return out;
}

/** 后端报错原文（尽量取出，方便定位） */
function backendMsg(res) {
  if (!res) return "";
  return String(res.msg || res.message || res.error || "").trim();
}

function viewCollection(view) {
  const v = DATA_VIEWS[view];
  return v ? v.collection : view;
}

/** 取某个视图要显示的条目（接口类型视图会过滤） */
function viewRows(view) {
  const v = DATA_VIEWS[view];
  const all = DATA_COLLECTIONS[viewCollection(view)] || [];
  if (!v || !v.filterField) return all;
  return all.filter(r => {
    const raw = r && r[v.filterField] != null ? String(r[v.filterField]).toLowerCase() : "";
    if (v.matchEmpty && (raw === "" || v.filterAny.includes(raw))) return true;
    return raw === String(v.filterValue).toLowerCase();
  });
}

function collectionIcon(key) {
  if (DATA_VIEWS[key]) return DATA_VIEWS[key].icon;
  return {
    api_list: "🔌", fortune_list: "🔮",
    word_reply_list: "📚", mount_list: "🐴", job_list: "🔨",
    greeting_morning_messages: "🌅", greeting_night_messages: "🌙",
    pet_list: "🐾", pet_work_events: "💼",
  pet_adventure_events: "🗺", pet_item_list: "🧪",
  }[key] || "🗄️";
}

/** 渲染当前视图对应的数据列表按钮条（切换按钮不改动其它配置） */
function renderCollectionTabs(activeKey, onlyKeys) {
  // onlyKeys 有值时只渲染这几项（每个功能页只看自己的列表）；
  // 传空则渲染全部（「数据管理」总览页用）
  const scope = (onlyKeys && onlyKeys.length) ? onlyKeys.slice() : null;
  const keys = dataCollectionKeys();
  if (!keys.length) return "";
  if (scope && !scope.some(k => viewAvailable(k))) return "";

  // 按 DATA_GROUPS 归组，并且只保留 scope 里的项
  const used = {};
  const groups = [];
  DATA_GROUPS.forEach(g => {
    let present = g.keys.filter(k => viewAvailable(k));
    if (scope) present = present.filter(k => scope.includes(k));
    if (!present.length) return;
    present.forEach(k => { used[k] = true; });
    groups.push({ title: g.title, keys: present });
  });
  // scope 里不在 DATA_GROUPS 里的项，归到「其他」
  if (scope) {
    const rest = scope.filter(k => !used[k] && viewAvailable(k));
    if (rest.length) groups.push({ title: "其他", keys: rest });
  }

  const oneItem = groups.length === 1 && groups[0].keys.length === 1;
  let html = `<div class="section data-tabs-section">`;
  html += `<div class="section-header"><div class="section-title">内容列表</div>
    <div class="muted">${oneItem
      ? "数据存在独立文件里，改完点右上角「💾 保存全部」一起写入"
      : "数据存在独立文件里；点下面的按钮切换要编辑的列表"}</div></div>`;
  html += `<div class="data-tabs">`;
  groups.forEach(g => {
    html += `<div class="data-tabs-group">`;
    // 只有一组时不用重复显示组名
    if (groups.length > 1) {
      html += `<span class="data-tabs-label">${esc(g.title)}</span>`;
    }
    g.keys.forEach(k => {
      const v = DATA_VIEWS[k];
      const n = viewRows(k).length;
      const label = v ? v.label : (DATA_LABELS[k] || k);
      const on = k === activeKey ? " active" : "";
      html += `<button class="data-tab${on}" data-collection="${esc(k)}">
        ${collectionIcon(k)} ${esc(label)}<span class="data-tab-num">${n}</span></button>`;
    });
    html += `</div>`;
  });
  html += `</div></div>`;
  return html;
}

/** 单独编辑某一个数据组（key 也可以是接口类型的虚拟视图） */
function renderCollectionEditor(key) {
  const v = DATA_VIEWS[key];
  const collKey = viewCollection(key);
  const allRows = DATA_COLLECTIONS[collKey] || [];
  const fields = DATA_FIELDS[collKey] || [];
  const label = v ? v.label : (DATA_LABELS[key] || key);
  // 真实索引 + 数据，保存/删除都按真实索引操作，避免错位
  const entries = [];
  allRows.forEach((r, i) => {
    const raw = v && v.filterField && r ? String(r[v.filterField] || "").toLowerCase() : "";
    if (v && v.filterField) {
      if (v.matchEmpty && (raw === "" || v.filterAny.includes(raw))) entries.push([i, r]);
      else if (raw === String(v.filterValue).toLowerCase()) entries.push([i, r]);
    } else {
      entries.push([i, r]);
    }
  });
  const shown = entries.length;
  const total = allRows.length;
  const isFiltered = !!(v && v.filterField);
  const countText = isFiltered && shown !== total
    ? `${shown} 条（全部 ${total} 条）` : `${total} 条`;

  // data-coll-view 记录「本编辑器属于哪个视图」，
  // 保存/新增据此定位，不再依赖易被覆盖的全局 DATA_CURRENT
  let html = `<div class="section" data-coll-view="${esc(key)}"` +
    `${v && v.filterField ? ` data-coll-filter="${esc(v.filterField)}"` : ""}>`;
  html += `<div class="section-header">
    <div class="section-title">${collectionIcon(key)} ${esc(label)}</div>
    <div class="muted">${countText}；改动后点右上角「💾 保存全部」一起写入</div>
  </div>`;
  html += `<div class="data-toolbar">
    ${v && v.hideAdd ? "" :
      '<button class="btn btn-primary btn-sm" data-action="data-add">+ 新增一条</button>'}
    <button class="btn btn-sm" data-action="data-reload">放弃改动并刷新</button>
    <span class="muted" data-role="data-hint">${countText}${DATA_DIRTY ? "（有未保存改动）" : ""}</span>
  </div>`;
  if (!fields.length) {
    html += `<div class="muted">该数据组没有可编辑字段</div>`;
  } else if (!shown) {
    html += `<div class="data-empty">（${v && v.empty ? v.empty : "暂无数据"}，点「新增一条」开始添加）</div>`;
  } else {
    html += renderRowsHtml(entries, fields, v && v.filterField);
  }
  html += `</div>`;
  return html;
}

/** 生成单条目的 HTML（idx 是真实索引；isNew=true 表示刚添加还没归位） */
function rowHtml(idx, row, fields, isNew, filterField) {
  // 过滤视图里，定位字段（filterField）只读，避免改了就「消失」
  const __ff = String(filterField || "");
  const __ROW_IS_FILTER_KEY__ = (fk) =>
    !!__ff && String(fk) === __ff;
  const attrs = `data-idx="${idx}"${isNew ? ' data-new="1"' : ""}`;
  let html = `<div class="data-item${isNew ? " data-item-new" : ""}" ${attrs}>`;
  html += `<div class="data-item-head">
    <span class="data-item-title">#${idx + 1}${isNew ? " · 新" : ""}</span>
    <span class="data-item-btns">
      <button class="btn btn-sm" data-action="data-up" data-idx="${idx}" title="上移">↑</button>
      <button class="btn btn-sm" data-action="data-down" data-idx="${idx}" title="下移">↓</button>
      <button class="btn btn-sm" data-action="data-dup" data-idx="${idx}">复制</button>
      <button class="btn btn-sm btn-danger" data-action="data-del" data-idx="${idx}">删除</button>
    </span>
  </div>`;
  html += `<div class="data-item-body">`;
  fields.forEach(f => {
    const val = dataFieldValue(row, f.key);
    const attr = `data-dfield="${esc(f.key)}" data-didx="${idx}"`;
    if (f.type === "select" && Array.isArray(f.options)) {
      let opt = "";
      const known = f.options.map(String);
      const extra = (val && !known.includes(val)) ? [val] : [];
      known.concat(extra).forEach(o => {
        opt += `<option value="${esc(o)}"${String(o) === val ? " selected" : ""}>${esc(o)}</option>`;
      });
      html += `<div class="form-group"><label>${esc(f.label)}</label>
        <select ${attr}>${opt}</select></div>`;
    } else if (f.type === "birdimg") {
      // 已废弃：图片改为按昵称自动识别，这里只保留兼容展示
      html += `<div class="form-group"><label>${esc(f.label)}</label>
        <div class="muted small">图片已改为按「小鸟昵称」自动识别，无需填写</div>
      </div>`;
    } else if (f.type === "text") {
      // ★ 多行文本（菜单内容、文案等）：textarea 才能看到换行
      const rows_ = Math.min(14, Math.max(3, String(val || "").split("\n").length + 1));
      html += `<div class="form-group"><label>${esc(f.label)}</label>
        <textarea ${attr} rows="${rows_}" class="textarea" spellcheck="false">${esc(val)}</textarea></div>`;
    } else if (__ROW_IS_FILTER_KEY__(f.key)) {
      // ★ 过滤视图里，用于定位本条数据的字段改了会「消失」，
      //   所以设为只读，并给出提示。
      html += `<div class="form-group"><label>${esc(f.label)}</label>
        <input type="text" ${attr} value="${esc(val)}" readonly
               class="input" style="opacity:.65;cursor:not-allowed"
               title="此字段用于定位本条数据，不能修改">
        <div class="muted small">用于定位本条数据，不可修改</div>
      </div>`;
    } else {
      html += `<div class="form-group"><label>${esc(f.label)}</label>
        <input type="text" ${attr} value="${esc(val)}" /></div>`;
    }
  });
  html += `</div></div>`;
  return html;
}

/** 真实 DOM 元素形式的新条目（用于直接插到顶部） */
function buildNewRowElement(collKey, row, fieldCount) {
  const fields = DATA_FIELDS[collKey] || [];
  // 新条目临时索引用一个足够大的值，避免与现有条目冲突
  let maxIdx = -1;
  document.querySelectorAll("#content .data-item").forEach(el => {
    const i = parseInt(el.dataset.idx);
    if (!isNaN(i) && i > maxIdx) maxIdx = i;
  });
  const tmpIdx = maxIdx + 1;
  const wrap = document.createElement("div");
  wrap.innerHTML = rowHtml(tmpIdx, row, fields, true, null);
  return wrap.firstElementChild;
}

function bindRowEvents(root) {
  if (!root) return;
  root.querySelectorAll("[data-action^='data-']").forEach(bindDataAction);
  root.querySelectorAll("[data-dfield]").forEach(el => {
    el.addEventListener("input", () => { DATA_DIRTY = true; markDirtyHint(); });
    el.addEventListener("change", () => {
      DATA_DIRTY = true; markDirtyHint();
      // 小鸟选图：换下拉即时刷新预览
      if (el.dataset.birdimg) {
        const wrap = el.closest(".bird-pick");
        if (wrap) {
          let img = wrap.querySelector(".bird-prev");
          if (el.value) {
            if (!img) {
              img = document.createElement("img");
              img.className = "bird-prev";
              wrap.insertBefore(img, wrap.firstChild);
            }
            img.src = birdPreviewUrl(el.value);
          } else if (img) {
            img.remove();
          }
        }
      }
    });
  });
}

function markDirtyHint() {
  const hint = document.querySelector('[data-role="data-hint"]');
  if (hint && !hint.textContent.includes("未保存")) {
    hint.textContent = hint.textContent + "（有未保存改动）";
  }
}

function renderRowsHtml(entries, fields, filterField) {
  let html = "";
  entries.forEach(([idx, row]) => {
    html += rowHtml(idx, row, fields, false, filterField);
  });
  return html;
}

/** 供某个功能视图使用：按钮条 + 当前选中数据组的编辑器 */
function renderSelector(keysWanted) {
  const wanted = (keysWanted || []).filter(k => viewAvailable(k));
  if (!wanted.length) {
    return `<div class="muted">数据未加载，请刷新页面重试</div>`;
  }
  if (!wanted.includes(DATA_CURRENT)) {
    // 该视图下没有记忆上一次选的是哪个列表，才回退到第一个
    DATA_CURRENT = wanted[0];
    DATA_DIRTY = false;
  }
  return renderCollectionTabs(DATA_CURRENT, wanted) + renderCollectionEditor(DATA_CURRENT);
}

function renderDataManager() {
  const keys = dataCollectionKeys();
  if (!keys.length) {
    return `<div class="section"><div class="muted">数据未加载，请刷新页面重试</div></div>`;
  }
  if (!viewAvailable(DATA_CURRENT)) {
    DATA_CURRENT = keys[0];
    DATA_DIRTY = false;
  }
  // 总览页显示全部数据组
  return renderCollectionTabs(DATA_CURRENT, null) + renderCollectionEditor(DATA_CURRENT);
}

/** 从一条 .data-item 元素读出它的字段值 */
function readRowFromEl(itemEl) {
  const row = {};
  itemEl.querySelectorAll("[data-dfield]").forEach(el => {
    row[el.dataset.dfield] = el.value;
  });
  return row;
}

/** 按 DOM 顺序读出条目，返回 [{idx, isNew, row}] */
function readDomEntries(items) {
  const out = [];
  const list = typeof items === "string"
    ? Array.from(document.querySelectorAll(items))
    : (items || []);
  list.forEach(itemEl => {
    const idx = parseInt(itemEl.dataset.idx);
    out.push({
      idx: isNaN(idx) ? -1 : idx,
      isNew: itemEl.dataset.new === "1",
      row: readRowFromEl(itemEl),
    });
  });
  return out;
}

/** 只读出「新增但还没归位」的行（按添加顺序） */
function collectNewRows(el) {
  return readDomEntries(editorItems(el || currentEditorEl()))
    .filter(e => e.isNew).map(e => e.row);
}

/**
 * 收集当前视图的行数据（保存用）。
 * 新条目在界面上插在最顶部方便编辑，但保存时按「最后添加」追加到末尾，
 * 这样既有添加的便利，又不会打乱原有顺序。
 */
function collectDataRows(el) {
  const entries = readDomEntries(editorItems(el || currentEditorEl()));
  // 原有条目按真实索引升序（= 原顺序）
  const base = entries.filter(e => !e.isNew).sort((a, b) => a.idx - b.idx);
  // 新条目按 DOM 顺序（后添加的插得更靠上，所以按索引升序还原添加先后）
  const fresh = entries.filter(e => e.isNew).sort((a, b) => a.idx - b.idx);
  return base.map(e => e.row).concat(fresh.map(e => e.row));
}

/**
 * 计算「保存全部」时该集合应写入的完整行数组。
 *
 * 关键：图片/视频/文本接口三个视图共享 api_list，
 * 若只把当前视图的条目整组覆盖保存，会把其它类型的接口删掉。
 * 因此过滤视图下采用「保留组内其它条目 + 按真实索引就地替换」的合并方式。
 */
function saveRowsFor(ed) {
  const view = editorView(ed);
  const coll = viewCollection(view);
  const all = DATA_COLLECTIONS[coll] || [];
  const v = DATA_VIEWS[view];

  const entries = readDomEntries(editorItems(ed));
  const base = entries.filter(e => !e.isNew).sort((a, b) => a.idx - b.idx);
  const fresh = entries.filter(e => e.isNew).sort((a, b) => a.idx - b.idx);

  // 非过滤视图：整组就是当前视图内容，保持原行为
  if (!v || !v.filterField) {
    const out = base.concat(fresh).map(e => e.row);
    console.debug(`[data] saveRowsFor(${coll}): DOM ${entries.length} 条 -> 取 ${out.length} 条`
      + `（内存副本 ${all.length} 条，其中新增 ${fresh.length} 条）`);
    return out;
  }

  // 过滤视图：组内「不属于本视图」的条目原样保留
  const inView = r => {
    const raw = r && r[v.filterField] != null
      ? String(r[v.filterField]).toLowerCase() : "";
    if (v.matchEmpty && (raw === "" || v.filterAny.includes(raw))) return true;
    return raw === String(v.filterValue).toLowerCase();
  };
  // 先记下界面上留下的真实索引
  const keptByIdx = new Map();
  base.forEach(e => { keptByIdx.set(e.idx, e.row); });

  // 逐条重放原数组：
  //   · 不属于本视图的        -> 原样保留（其它类型的接口不能动）
  //   · 在本视图但界面上没了   -> 就是被删掉了，丢弃
  //   · 在本视图且界面上还在   -> 用界面上的值替换（改完生效）
  const merged = [];
  all.forEach((r, i) => {
    if (!inView(r)) {
      merged.push(r);
      return;
    }
    if (keptByIdx.has(i)) merged.push(keptByIdx.get(i));
    // 界面缺席 = 已删除，不 push
  });
  fresh.forEach(e => merged.push(e.row));
  return merged;
}

function rememberDataSelection(view) {
  if (view && DATA_CURRENT) DATA_REMEMBER[view] = DATA_CURRENT;
}

function recallDataSelection(view) {
  if (view && DATA_REMEMBER[view]) DATA_CURRENT = DATA_REMEMBER[view];
}

function attachDataEvents() {
  // 数据列表按钮：切换要编辑的数据组
  document.querySelectorAll("#content [data-collection]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const k = btn.dataset.collection;
      if (!k || k === DATA_CURRENT) return;
      if (DATA_DIRTY) {
        const _go = await uiConfirm("当前有未保存的改动，切换后会丢失，确定继续吗？");
        if (!_go) return;
      }
      DATA_CURRENT = k;
      DATA_DIRTY = false;
      render();
    });
  });

  // 记住「当前视图」选中的列表，来回切视图不会被重置
  const activeNav = document.querySelector(".nav-item.active");
  if (activeNav) rememberDataSelection(activeNav.dataset.view);

  document.querySelectorAll("#content [data-action^='data-']").forEach(bindDataAction);

  // ★★ 1.7.7：银行冻结面板（首次进来时懒加载一次，加载完重绘）
  const _bfp = document.querySelector("#content .bank-frozen-panel");
  if (_bfp) {
    bindBankFrozenActions();
    if (_bfp.dataset.bankLoaded === "0") {
      _bfp.dataset.bankLoaded = "loading";   // 防止重复触发
      loadBankFrozen().then(() => {
        if (document.querySelector("#content .bank-frozen-panel")) render();
      });
    }
  }

  document.querySelectorAll("#content [data-dfield]").forEach(el => {
    el.addEventListener("input", () => { DATA_DIRTY = true; markDirtyHint(); });
    el.addEventListener("change", () => { DATA_DIRTY = true; markDirtyHint(); });
  });
}

function bindDataAction(btn) {
  if (btn.dataset.dshBound) return;
  btn.dataset.dshBound = "1";
  btn.addEventListener("click", async () => {
      const act = btn.dataset.action;
      const idx = btn.dataset.idx != null ? parseInt(btn.dataset.idx) : -1;
      if (act === "bird-status-refresh") {
        await loadBirdStatus();
        toast("已重新识别");
        render();
        return;
      }
      // ★ 1.7.6：坐骑图片重新识别
      if (act === "mount-status-refresh") {
        await loadMountStatus();
        toast("已重新识别");
        render();
        return;
      }
      if (act === "bird-custom") {
        // 展开手动输入栏并聚焦
        const ed = btn.closest(".section[data-coll-view]") || document;
        ed.querySelectorAll('[data-role="bird-custom-bar"]').forEach(el => {
          el.classList.toggle("open");
          if (el.classList.contains("open")) {
            const inp = el.querySelector('[data-role="bird-custom-input"]');
            if (inp) { inp.focus(); inp.select(); }
          }
        });
        return;
      }
      if (act === "bird-custom-go") {
        const bar = btn.closest('[data-role="bird-custom-bar"]');
        const inp = bar && bar.querySelector('[data-role="bird-custom-input"]');
        const dir = (inp && inp.value || "").trim();
        if (!dir) { toast("请先填写目录路径", "error"); return; }
        BIRD_CUSTOM_DIR = dir;
        const r = await browseBirdDir(dir);
        if (r) {
          // 顺带把下拉框也换成这个目录的文件，选起来更顺
          BIRD_FILES = r.files || [];
          toast(`已打开 ${r.dir}（${BIRD_FILES.length} 张图）`);
        }
        render();
        return;
      }
      if (act === "bird-goto") {
        const target = (btn.dataset.dir || "").trim();
        if (!target) return;
        const r = await browseBirdDir(target);
        if (r) { BIRD_CUSTOM_DIR = r.dir; BIRD_FILES = r.files || []; }
        render();
        return;
      }
      if (act === "bird-pick") {
        const file = btn.dataset.file || "";
        const ed = btn.closest(".section[data-coll-view]") || document;
        const sel = ed.querySelector("[data-birdimg]");
        if (sel) {
          const known = Array.from(sel.options).map(o => o.value);
          if (!known.includes(file)) {
            const o = document.createElement("option");
            o.value = file; o.textContent = file;
            sel.appendChild(o);
          }
          sel.value = file;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        render();
        return;
      }
      if (act === "bird-refresh") {
        if (BIRD_CUSTOM_DIR) {
          const r = await browseBirdDir(BIRD_CUSTOM_DIR);
          if (r) { BIRD_FILES = r.files || []; toast(`已刷新 ${BIRD_FILES.length} 个素材`); }
          render();
          return;
        }
        CURRENT_DIR_HINT = (CONFIG && CONFIG.bird_image_dir) || "";
        const ok = await loadBirdFiles();
        toast(ok ? `已读取 ${BIRD_FILES.length} 个素材` : "读取素材失败，检查「小鸟图片目录」",
              ok ? "success" : "error");
        render();
        return;
      }
      if (act === "data-add") {
        const ed = btn.closest(".section[data-coll-view]") || currentEditorEl();
        const collKey = editorCollection(ed) || currentCollectionKey();
        const v = DATA_VIEWS[editorView(ed)];
        if (v && v.hideAdd) {
          toast("这个视图不支持新增（每条对应一个固定菜单）", "error");
          return;
        }
        if (!collKey) {
          toast("无法确定要新增到哪个数据组，请刷新页面重试", "error");
          return;
        }
        const fields = DATA_FIELDS[collKey] || [];
        const row = {};
        fields.forEach(f => {
          row[f.key] = f.type === "select" && Array.isArray(f.options)
            ? String(f.options[0]) : "";
        });
        // 在「视频接口 / 文本接口」里新增时自动带上对应返回类型
        if (v && v.filterField && v.filterValue) row[v.filterField] = v.filterValue;

        // 先把界面上已填的内容收进内存（过滤视图下会保留组内其它条目）
        DATA_COLLECTIONS[collKey] = saveRowsFor(ed);

        // 新条目直接插到列表最顶部，不重建整页（避免丢失已填内容）
        const newEl = buildNewRowElement(collKey, row, fields.length);
        // 列表容器：条目元素的父节点；空数据时用提示块的父节点
        const scope = ed || document;
        const firstItem = scope.querySelector(".data-item");
        const emptyEl = scope.querySelector(".data-empty");
        const host = firstItem ? firstItem.parentElement
                               : (emptyEl ? emptyEl.parentElement : null);
        if (host) {
          if (emptyEl) emptyEl.style.display = "none";
          host.insertBefore(newEl, firstItem || emptyEl || null);
          DATA_DIRTY = true;
          markDirtyHint();
          bindRowEvents(newEl);
          const firstField = newEl.querySelector("[data-dfield]");
          if (firstField && typeof firstField.focus === "function") firstField.focus();
        } else {
          // 极端情况兜底：整页重建
          DATA_DIRTY = true;
          render();
        }
        return;
      }
      if (act === "data-reload") {
        if (DATA_DIRTY) {
          const _go = await uiConfirm("放弃未保存的改动？", { okText: "放弃" });
          if (!_go) return;
        }
        await loadCollections();
        DATA_DIRTY = false;
        render();
        return;
      }
      // 以下需要对内存数组操作（按真实集合，索引也是真实索引）
      // ★ 用 saveRowsFor 而非整组覆盖：过滤视图（图片/视频/文本接口）
      //   共享 api_list，整组覆盖会把其它类型的接口一起删掉。
      //   它保留原索引，所以下面按 idx 的 splice/交换仍然指向同一条数据。
      const ed2 = btn.closest(".section[data-coll-view]") || currentEditorEl();
      const collKey2 = editorCollection(ed2) || currentCollectionKey();
      if (!collKey2) {
        toast("无法确定要操作哪个数据组，请刷新页面重试", "error");
        return;
      }
      const rows = saveRowsFor(ed2);
      DATA_COLLECTIONS[collKey2] = rows;
      const arr = DATA_COLLECTIONS[collKey2];
      if (act === "data-del") {
        // ★ 不再弹确认框：删除只是**改内存 + 重渲染**，真正落盘要点
        //   「保存全部」，所以误删可以直接再新增回来，没必要多一次点击。
        //   （而且沙箱 iframe 里原生 confirm 会被拦，反而制造过 bug）
        arr.splice(idx, 1);
      } else if (act === "data-dup") {
        arr.splice(idx + 1, 0, Object.assign({}, arr[idx]));
      } else if (act === "data-up") {
        if (idx <= 0) return;
        const t = arr[idx - 1]; arr[idx - 1] = arr[idx]; arr[idx] = t;
      } else if (act === "data-down") {
        if (idx >= arr.length - 1) return;
        const t = arr[idx + 1]; arr[idx + 1] = arr[idx]; arr[idx] = t;
      }
      DATA_DIRTY = true;
      render();
  });
}

// ============================================================
// 视图定义
// ============================================================
const VIEWS = {
  // ★★ 市场版 1.1：机器人数据（左侧第一个按钮）
  botstats: {
    title: "机器人数据",
    groups: [
      { title: "📊 机器人数据总览", type: "botstats" },
      { title: "这一页怎么用", type: "hint", tone: "info", text:
        "· 数字是**插件启动以来**的累计值，重载插件会清零\n" +
        "· 「见过消息的群」「运行时长」在插件刚启动时是 0 / 很小，属正常\n" +
        "· 数据集合、菜单、配置项、Web 路由是**当前实际加载**的数量\n" +
        "· 想刷新：回到本页会自动重新读取，或点右上角「💾 保存全部」旁边的刷新" },
    ],
  },
  menu: {
    title: "菜单指令",
    groups: [
      { title: "全局标题前缀（影响所有指令输出的标题）",
        keys: ["title_prefix"] },
      { title: "全局标题前缀说明", type: "hint", tone: "info",
        text: "🏷️ **所有指令**输出的标题都会带这个前缀，例如：\n" +
              "· 填 `铁剑娘系统` → `铁剑娘系统：机器人运行状态`（冒号自动补）\n" +
              "· **留空 = 不显示前缀**，只显示 `机器人运行状态`\n" +
              "　 （填 `无` / `关闭` / `none` 也一样等于不要前缀）\n" +
              "\n生效范围：菜单、电脑状态、签到统计、三个排行榜、宠物查看、" +
              "猜拳、图鉴、银行、坐骑、打工、抽奖、点歌、管理员列表……**全部输出**。" },
      { title: "主菜单与子菜单入口", keys: ["cmd_main", "cmd_meme_menu", "cmd_mc_menu", "cmd_greeting_menu", "cmd_checkin_menu", "cmd_daily_menu", "cmd_admin"] },
      { title: "菜单效果预览", type: "menu-preview" },
      { title: "菜单输出内容（主菜单 + 全部子菜单，可自定义）",
        type: "data-selector", keys: ["menu_texts"] },
      { title: "菜单内容说明", type: "hint", tone: "info",
        text: "📝 每个菜单都能单独改输出内容：\n" +
              "· 左侧选一个菜单 → 改下面「菜单输出内容」→ 点「💾 保存全部」\n" +
              "· 内容是**原样发出**的文本，支持换行\n" +
              "· **把内容清空并保存 = 自动恢复系统默认**（下次读取后台数据时重新生成）\n" +
              "· 「菜单标识」是内部键，别改，否则对应不上菜单\n" +
              "\n★ 图标 / 两列排版：**截图所见即所得**，后台里直接改就行。" +
              "\n\n⚠️ **实时菜单**（改这里没用，请改对应功能页的配置）：\n" +
              "· `checkin_lottery` 抽奖功能 —— 每次花费/奖品上限/每天次数等\n" +
              "· `checkin_bank` 银行功能 —— 借款利息/上限/抢银行概率等\n" +
              "这两条菜单每次都会**按当前配置即时生成**，保证显示的数字和实际生效的一致。" },
    ],
  },
  meme: {
    title: "接口系统",
    groups: [
      { title: "功能开关", keys: ["meme_feature_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["meme_groups"] },
      { title: "指令配置", keys: ["cmd_meme_image", "cmd_meme_video", "cmd_meme_text"] },
      { title: "每群屏蔽关键词", keys: ["group_block_keywords"] },
      { title: "基础配置", keys: ["cmd_list", "cmd_add", "cmd_del", "cmd_save", "default_key"] },
      { title: "接口配置列表", type: "data-selector", keys: ["api_image", "api_video", "api_text"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 接口系统` / `开启功能 接口系统`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  mc: {
    title: "MC 系统",
    groups: [
      { title: "功能开关", keys: ["minecraft_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["minecraft_groups"] },
      { title: "指令配置", keys: ["cmd_minecraft", "cmd_mc_auto", "cmd_mc_test"] },
      { title: "检测参数", keys: ["minecraft_check_interval"] },
      { title: "自动检测的群号（必填，留空=不自动检测）",
        keys: ["minecraft_auto_groups"] },
      { title: "测试推送的群号（留空=所有开启自动检测的群）",
        keys: ["minecraft_test_groups"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 MC系统` / `开启功能 MC系统`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  greeting: {
    title: "打卡系统",
    groups: [
      { title: "功能开关", keys: ["greeting_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["greeting_groups"] },
      { title: "指令配置", keys: ["cmd_greeting_morning", "cmd_greeting_night", "cmd_greeting_rank", "cmd_greeting_stats"] },
      { title: "时间与规则", keys: ["greeting_time_format", "greeting_day_start_hour", "greeting_morning_cutoff_hour", "greeting_night_cutoff_hour", "greeting_night_cutoff_minute", "greeting_min_awake_seconds", "greeting_max_repeat_remind"] },
      { title: "文案列表", type: "data-selector", keys: ["greeting_morning_messages", "greeting_night_messages"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 打卡系统` / `开启功能 打卡系统`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  checkin: {
    title: "签到系统",
    groups: [
      { title: "功能开关", keys: ["checkin_enable"] },
      { title: "积分显示名称（全局，影响所有功能）", keys: ["score_name"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["checkin_groups"] },
      { title: "指令配置", keys: ["checkin_trigger_names", "checkin_rank_trigger_names", "checkin_info_trigger_names"] },
      { title: "🧭 菜单入口名（1.7.7，改了立刻生效）",
        keys: ["menu_checkin_signin_names", "menu_checkin_query_names",
               "menu_checkin_bank_names", "menu_checkin_lottery_names",
               "menu_checkin_steal_names",
               "menu_checkin_job_names", "menu_checkin_shop_help_names",
               "menu_job_list_names", "menu_job_refill_names",
               "menu_stamina_names", "menu_stamina_eat_names",
               "menu_bank_save_names", "menu_bank_loan_names",
               "menu_bank_fund_names", "menu_bank_rob_names",
               "menu_pet_names", "menu_pet_care_names",
               "menu_pet_fight_names", "menu_pet_item_names"] },
      { title: "菜单入口名怎么用", type: "hint", tone: "tip", text:
        "🧭 **改完立刻生效**（不用重载插件）—— 群里发新名字就能打开，\n" +
        "　 菜单里显示的入口名也会同步跟着变。\n" +
        "\n" +
        "· 每个入口可以填**多个名字**，用英文逗号分隔（都认）\n" +
        "· 改过名之后，**旧名字仍然可用**（不会把别人搞懵）\n" +
        "· 留空 = 用默认名\n" +
        "· ⚠️ 别和其他**指令**重名。例如「抢银行帮助」不能改成「抢银行」\n" +
        "　 （那是抢银行指令本身）；「签到商店」是那条查看商品的**指令**，\n" +
        "　 在「签到商店」功能页里改，不在这里。\n" +
        "· 保存时会自动检查指令冲突并提示" },
      { title: "排行榜指令（1.7.6，三条独立，显示在「查询指令」里）",
        keys: ["checkin_rank_count_names", "checkin_rank_wealth_names",
               "checkin_rank_debt_names"] },
      { title: "排行榜说明", type: "hint", tone: "tip", text:
        "1.7.6 起排行榜拆成**三条独立指令**：\n" +
        "· `签到次数排行` —— 按累计签到次数\n" +
        "· `总财富排行` —— 按 **钱包 + 银行 − 欠款**\n" +
        "· `负债排行` —— 按欠款，欠得越多越靠前 😈\n" +
        "★ 已从「签到系统」菜单移除旧的「🏆签到排行」入口，" +
        "现在统一放在「📊查询指令」下级菜单里。" },
      { title: "签到随机积分（每次签到拿多少）",
        keys: ["checkin_score_min", "checkin_score_max"] },
      { title: "签到随机积分怎么算", type: "hint", tone: "tip", text:
        "每次签到从「下限 ~ 上限」里**随机取一个数**加给签到的人。\n" +
        "· 默认 1 ~ 1000\n" +
        "· 想固定给分：下限 = 上限（例如都填 100，每次固定 +100）\n" +
        "· 想给多点：上限填 5000，就是 1 ~ 5000\n" +
        "· 上限填得比下限小也没关系，会自动按下限算\n" +
        "改完保存即生效，不用重启。" },
      {
        title: "作弊 · 积分调整",
        keys: ["score_admin_feature_enable", "score_admin_groups",
               "score_admin_whitelist",
               "cmd_score_add_names", "cmd_score_sub_names",
               "wipe_wealth_trigger_names"],
      },
      { title: "🧹 清空财富（管理员，不可撤销）", type: "hint", tone: "warn",
        text:
        "🧹 **清空财富** —— 把一个群员的**所有财富归零**\n" +
        "· 用法：`清空财富 @某人` 或 `清空财富 QQ号`\n" +
        "· 清掉：钱包 / 银行 / 保险箱 / 欠款（含逾期罚息）/ 理财本金\n" +
        "· **保留**：签到次数、连签、坐骑、武器、食物、打工冷却\n" +
        "· ⚠️ **不可撤销**，也没有二次确认 —— 谨慎使用\n" +
        "· 权限和「加积分 / 减积分」完全一致\n" +
        "　 （只认 AstrBot 全局管理员 + 上面「加减积分 QQ 白名单」）\n" +
        "· 指令名可在上面那一栏改（`wipe_wealth_trigger_names`）" },
      { title: "加减积分谁能用", type: "hint", tone: "warn", text:
        "**只有两种人能加/减积分：**\n" +
        "① AstrBot **全局管理员**（在 AstrBot 主配置的 admins_id 里）\n" +
        "② 上面「加减积分 QQ 白名单」里填的 QQ\n" +
        "**群主、群管理员都不能用** —— 这个功能能凭空造分，" +
        "权限刻意收紧。\n" +
        "白名单填法：一行一个 QQ 号，例如\n　`123456789`\n　`987654321`\n" +
        "留空 = 只认全局管理员。" },
      { title: "积分显示名称怎么用", type: "hint", tone: "tip", text:
        "· 这里改的是**显示名**：填「金币」后各处都显示「金币：1000」\n" +
        "· 影响范围：签到统计 / 排行榜 / 偷积分 / 银行 / 坐骑 / 打工 / " +
        "宠物 / 猜拳 / 积分调整\n" +
        "· **不影响指令名**：「加积分」「减积分」「偷积分」这些触发词" +
        "在各自的「指令配置」里改\n" +
        "· 留空或填「积分」= 用默认名" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 签到系统` / `开启功能 签到系统`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  steal: {
    title: "偷积分",
    groups: [
      { title: "功能开关", keys: ["steal_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["steal_groups"] },
      { title: "指令与范围", keys: ["steal_trigger_names", "steal_min", "steal_max"] },
      { title: "概率与惩罚", keys: ["steal_success_rate", "steal_fail_punish_rate", "steal_punish_min", "steal_punish_max"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 神偷功能` / `开启功能 神偷功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  bank: {
    title: "银行",
    groups: [
      { title: "功能开关", keys: ["bank_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["bank_groups"] },
      { title: "指令配置", keys: ["bank_trigger_names", "bank_deposit_names", "bank_withdraw_names"] },
      { title: "利率与结算", keys: ["bank_interest_rate", "bank_interest_hour"] },
      { title: "借款（1.7.6）", keys: ["loan_enable", "loan_trigger_names", "loan_repay_names", "loan_info_names", "loan_max", "loan_interest_rate"] },
      { title: "扣款方式（1.7.6）", keys: ["use_bank_pay"] },
      { title: "抢银行（1.7.6，银行子功能）",
        keys: ["rob_enable", "rob_trigger_names", "rob_success_rate",
               "rob_min", "rob_max", "rob_freeze_days",
               "rob_fail_penalty_rate", "rob_groups"] },
      { title: "💼 理财（1.7.6 新增，银行子功能）",
        keys: ["fund_enable", "fund_trigger_names", "fund_buy_names",
               "fund_sell_names", "fund_profit_max", "fund_loss_max"] },
      { title: "🧊 冻结账号（查看 / 提前解冻）", type: "bankfreeze" },
      { title: "批量解冻（多个 QQ 用英文逗号分隔）",
        keys: ["bank_unfreeze_list"] },
      { title: "解冻怎么用", type: "hint", tone: "tip", text:
        "🧊 **冻结账号** —— 抢银行失败会被冻结银行，这里能看到全部冻结中的账号\n" +
        "　 点某条的「🗑 解除冻结」即可**单独**提前解除\n" +
        "\n" +
        "⚡ **批量解冻** —— 在下面输入框填 QQ 号，**英文逗号分隔**\n" +
        "　 例：`123456,234567,345678`\n" +
        "　 保存后自动解除；该 QQ 在**所有群**的冻结会一起解掉\n" +
        "　 解完输入框自动清空（避免下次保存又解一遍）\n" +
        "\n" +
        "⚠️ 冻结是**按群**记的：同一个 QQ 在多个群可能各有一条冻结。\n" +
        "　 填 QQ 号 = 全解；只想解某一个群，用上面列表里的按钮。" },
      { title: "🧭 菜单入口名（1.7.7，改了立刻生效）",
        keys: ["menu_checkin_bank_names", "menu_bank_save_names",
               "menu_bank_loan_names", "menu_bank_fund_names",
               "menu_bank_rob_names"] },
      { title: "入口名怎么用", type: "hint", tone: "tip", text:
        "🧭 **改完立刻生效**（不用重载插件）：群里发新名字就能打开，\n" +
        "　 菜单里显示的入口名也同步跟着变。\n" +
        "· 可填**多个名字**，英文逗号分隔（都认）；留空 = 用默认名\n" +
        "· 改过名后**旧名字仍然可用**\n" +
        "· ⚠️ 别和别的**指令**重名（例如不能把「抢银行帮助」改成「抢银行」）" },
      { title: "理财怎么用", type: "hint", tone: "tip", text:
        "💼 **银行理财** —— 把钱投进去，每天随机盈亏\n" +
        "\n" +
        "· 买入：`购买理财 金额`（或 `购买理财 all`）—— 从**钱包**掏钱\n" +
        "· 之后**每天随机盈亏一次**：\n" +
        "　 盈利最多 `fund_profit_max`%（默认 8）→ 直接加到买入金额上\n" +
        "　 亏损最多 `fund_loss_max`%（默认 6）→ 从买入金额里扣\n" +
        "　 ⚠️ **本金不够扣时，从你的资产（钱包→银行）补扣**\n" +
        "· 查看：`理财` —— 显示本金 / 累计盈亏 / 持有天数，\n" +
        "　 **并明确显示「今天是盈利 / 今天亏损」**\n" +
        "· 取出：`取出理财`（全部）或 `取出理财 金额`\n" +
        "　 ⭐ **取出的钱进银行账户**，随时可取\n" +
        "· 结算时机：每天第一次查看/操作理财时结算一次，不需要定时任务\n" +
        "· 群开关：`开启功能 理财` / `关闭功能 理财`" },
      { title: "抢银行说明", type: "hint", tone: "warn", text:
        "· 每天一次、**没有参数**：直接发 `抢银行` 就抢\n" +
        "· **成功**（`rob_success_rate` %）：在 `rob_min~rob_max` 之间随机抢一笔，\n" +
        "　 钱从**全群银行余额**里出（池子不够就按池子里有的给），直接进你的钱包\n" +
        "· **失败**：银行账户冻结 `rob_freeze_days` 天 +\n" +
        "　 没收 `rob_fail_penalty_rate` 比例的财产（0.5 = 钱包+银行的一半）\n" +
        "· 冻结期间**存/取/借/还/查询全部不可用**\n" +
        "· 默认成功率只有 5%，故意让人心疼 😈\n" +
        "· 群开关：`开启功能 抢银行` / `关闭功能 抢银行`" },
      { title: "⏰ 逾期罚息 / 老赖（1.7.6 新增）", keys: ["loan_due_days", "loan_overdue_step_hours", "loan_overdue_rate", "loan_deadbeat_days", "loan_deadbeat_tag", "loan_overdue_notice"] },
      { title: "逾期规则说明", type: "hint", tone: "danger", text:
        "· 借款时记下**还款期限**（`loan_due_days` 天）；超过就开始算逾期\n" +
        "· 逾期后每 `loan_overdue_step_hours` 小时加一次罚息\n" +
        "　 每次 = **本金** × `loan_overdue_rate`（按本金算，不是复利）\n" +
        "　 例：本金 1000、罚息 5%、每 24 小时一次 → 逾期 3 天 = +150\n" +
        "· 逾期满 `loan_deadbeat_days` 天 → 挂上 `loan_deadbeat_tag` 标签\n" +
        "　 默认 `0` = **一逾期就挂**；标签会出现在「借款信息」和「负债排行」\n" +
        "· **还清后标签自动消失**，`loan_due` / 罚息一起归零\n" +
        "· 关掉整套惩罚：`loan_due_days` 填 `0`（不设期限）或 `loan_overdue_rate` 填 `0`\n" +
        "　 这两种情况都**不会**挂老赖标签\n" +
        "· 罚息在**借款 / 还款 / 查借款信息 / 看负债排行**时自动结算，不怕漏收" },
      { title: "借款说明", type: "hint", tone: "warn", text:
        "· 借款会把**本金 + 利息**记成欠款，钱直接进钱包（`total_score`），欠款单独记\n" +
        "· 利息在**借款时一次性计入**，默认 `0.30` = 三成 —— 默认就偏高，显得银行不是好人 😈\n" +
        "· `use_bank_pay` 开启时：**买东西先扣钱包，钱包不够自动扣银行**\n" +
        "· 可用资金 = 钱包 + 银行；净值 = 钱包 + 银行 − 欠款\n" +
        "· **总财富 = 钱包 + 银行 − 欠款**（总财富排行按这个排）\n" +
        "· 两个都扣光了才会提示去借款\n" +
        "· 用法：`借款 1000` / `借款`（借满上限）/ `还款 500` / `还款 all` / `借款信息`" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 银行功能` / `开启功能 银行功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  lottery: {
    title: "抽奖",
    groups: [
      { title: "功能开关（总开关）", keys: ["lottery_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["lottery_groups"] },
      { title: "指令配置（含「全部抽奖」1.7.6 新增）",
        keys: ["lottery_trigger_names", "lottery_all_trigger_names"] },
      { title: "每次花多少 / 奖品上限", keys: ["lottery_cost", "lottery_prize_max", "lottery_win_rate", "lottery_daily_limit"] },
      { title: "🎁 奖池（1.7.6 新增）",
        keys: ["lottery_pool_enable", "lottery_pool_trigger_names",
               "lottery_pool_info_names", "lottery_pool_fee",
               "lottery_pool_slots", "lottery_pool_min",
               "lottery_pool_max", "lottery_pool_timeout_hours",
               "lottery_pool_groups"] },
      { title: "奖池玩法说明", type: "hint", tone: "warn", text:
        "· 指令 `参与抽奖`（可自定义）—— **没有参数**，每人每天只能参与一次\n" +
        "· 参与要交 `lottery_pool_fee`（入门费），**直接归系统、不退**，不进奖池\n" +
        "· 奖池的钱由**系统出**：每天在 `lottery_pool_min ~ lottery_pool_max` 里随机一个数\n" +
        "· 名额 `lottery_pool_slots` 人，**满了立刻开奖**，不需要额外指令\n" +
        "· 名额没满：`lottery_pool_timeout_hours`（**小时**，默认 1）到点**自动开奖**；填 0 = 不自动开\n" +
        "· 开奖时奖池金额**全额随机分完**给所有参与者，各自直接进**钱包**\n" +
        "　 （每人先有保底，剩下的随机分，总和精确等于奖池，一分不剩）\n" +
        "· 名额没满：第二天奖池**重新随机**，前一天的作废（不累积）\n" +
        "· 查询进度：`奖池`（可自定义 `lottery_pool_info_names`）\n" +
        "· 群开关：`开启功能 奖池` / `关闭功能 奖池`\n" +
        "· ⚠️ 奖池的钱是**系统凭空发**的，注意别配太大导致通胀" },
      { title: "抽奖说明", type: "hint", tone: "warn", text:
        "· 指令**不带参数**：直接发 `开始抽奖` 就行\n" +
        "· `lottery_cost` = **每次固定花多少**，先扣掉（这是消费）\n" +
        "· 中奖后再**额外**加奖励，奖励在 `0 ~ lottery_prize_max` 之间随机\n" +
        "· 奖品**下限固定为 0**，所以会「中奖但空手而归」😂\n" +
        "· `lottery_daily_limit` = **每天最多抽几次**，填 `0` = 不限次数\n" +
        "· 扣成负数就是**负债**，会提示去银行借款\n" +
        "· 每次签到后，消息末尾也会提示这个玩法\n" +
        "· 这是签到子功能：群开关用 `开启功能 抽奖功能` / `关闭功能 抽奖功能`" },
    ],
  },
  mount: {
    title: "坐骑系统",
    groups: [
      { title: "功能开关", keys: ["mount_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["mount_groups"] },
      { title: "指令配置", keys: ["mount_menu_names", "mount_trigger_names", "mount_list_trigger_names", "mount_buy_trigger_names", "cmd_mount_add_names", "cmd_mount_del_names"] },
      { title: "🐴 坐骑设置", keys: ["mount_equip_names", "mount_view_names", "mount_greet_enable", "mount_greet_text"] },
      { title: "每天登场提示", type: "hint", tone: "warn", text:
        "· 每个群**每天第一条消息**触发一次：谁发的话 + 他装备的坐骑\n" +
        "　 → `🌟 某某 骑着「赤兔」闪亮登场！`\n" +
        "· 发消息的人**没装备坐骑**：静默跳过（这一天的机会就用了）\n" +
        "· 文案可改：`mount_greet_text`，占位符 `$name` `$mount` `$group` `$uid`\n" +
        "· 关掉：`mount_greet_enable` 设为 false" },
      { title: "🧭 菜单入口名（1.7.7，改了立刻生效）",
        keys: ["mount_menu_names", "menu_mount_manage_names",
               "menu_mount_admin_names"] },
      { title: "入口名怎么用", type: "hint", tone: "tip", text:
        "🧭 **改完立刻生效**（不用重载插件）：群里发新名字就能打开，\n" +
        "　 菜单里显示的入口名也同步跟着变。\n" +
        "· 可填**多个名字**，英文逗号分隔（都认）；留空 = 用默认名\n" +
        "· 改过名后**旧名字仍然可用**\n" +
        "· ⚠️ 别和别的**指令**重名\n" +
        "\n" +
        "🐴 1.7.7 起坐骑功能拆成两个下级菜单：\n" +
        "　 `坐骑管理` —— 装备坐骑 / 坐骑查看详情 / 翻页说明\n" +
        "　 `坐骑设置` —— 管理员指令 / 图片目录 / 登场提示" },
      { title: "坐骑列表", type: "data-selector", keys: ["mount_list"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 坐骑功能` / `开启功能 坐骑功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  job: {
    title: "打工系统",
    groups: [
      { title: "功能开关", keys: ["job_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["job_groups"] },
      { title: "指令配置", keys: ["job_trigger_names", "job_info_trigger_names", "job_all_trigger_names", "cmd_job_add_names", "cmd_job_del_names"] },
      { title: "⚡ 体力系统（1.7.7 新增）",
        keys: ["stamina_enable", "stamina_max", "job_stamina_min",
               "job_stamina_max", "stamina_food_restore"] },
      { title: "⚡ 体力系统 · 加班与指令（1.7.7 重写）",
        keys: ["stamina_refill_menu_names", "stamina_refill_status_names",
               "stamina_refill_trigger_names", "stamina_refill_all_names",
               "stamina_refill_per_hour", "stamina_refill_min",
               "stamina_view_trigger_names", "food_eat_trigger_names"] },
      { title: "体力系统怎么用", type: "hint", tone: "tip", text:
        "⚡ **体力系统**（1.7.7 新增）\n" +
        "· 每人每天 `体力上限` 点，**每天 0 点回满**，不累积\n" +
        "· 每个打工随机消耗 `最少~最多` 体力（体力不够就干不了）\n" +
        "　 单个工种可在「工种列表」里用 `stamina_min` / `stamina_max` 覆盖\n" +
        "\n🍖 **食物恢复体力**\n" +
        "· 在「签到商店」的 `shop_list` 里加 kind=`food` 的商品\n" +
        "· 食物是**消耗品**，可反复购买、进背包\n" +
        "· 恢复量用 `stamina_restore` 字段，留空用「食物默认恢复体力」\n" +
        "· 指令：「吃食物 名字 / 序号 / 全部」\n" +
        "\n🔥 **加班（花体力一键清冷却）**\n" +
        "· 消耗 = 剩余小时（不足 1 小时按 1 算）× `每小时体力`，最低 `加班最低消耗`\n" +
        "\n📋 **加班拆成三条（1.7.7 重写）**\n" +
        "· `加班功能` → **主菜单**，输出下级菜单（名字用 `主菜单入口名`）\n" +
        "· `加班状态` → 只列**可加班 / 不可加班**工种\n" +
        "　 可加班的会标出清掉冷却要多少体力（用 `状态指令名`）\n" +
        "· `加班 工种名` → 只清这一个工种的冷却（用 `执行指令名`）\n" +
        "· `加班全部` → 一键清掉所有冷却中的工种（用 `全部清掉指令名`）\n" +
        "\n⚠️ **这四个名字是四个独立的键，别设成一样的** ——\n" +
        "　 主菜单入口名和执行指令名撞在一起的话，指令会打不开。\n" +
        "\n💡 体力值也会显示在「签到统计」和「我的体力」里。" },
      { title: "工种列表", type: "data-selector", keys: ["job_list"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 打工功能` / `开启功能 打工功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  shop: {
    title: "签到商店",
    groups: [
      { title: "功能开关", keys: ["shop_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["shop_groups"] },
      { title: "指令配置",
        keys: ["shop_trigger_names", "shop_buy_trigger_names",
               "shop_save_trigger_names", "shop_take_trigger_names",
               "shop_equip_trigger_names", "my_equip_trigger_names"] },
      { title: "🧭 菜单入口名（1.7.7，改了立刻生效）",
        keys: ["menu_checkin_shop_help_names"] },
      { title: "入口名怎么用", type: "hint", tone: "tip", text:
        "🧭 **改完立刻生效**（不用重载插件）：群里发新名字就能打开，\n" +
        "　 菜单里显示的入口名也同步跟着变。\n" +
        "· 可填**多个名字**，英文逗号分隔（都认）；留空 = 用默认名\n" +
        "· 改过名后**旧名字仍然可用**\n" +
        "· ⚠️ 别和别的**指令**重名（例如不能把「商店帮助」改成「签到商店」）" },
      { title: "🧰 保险箱与防御数值",
        keys: ["vault_steal_reduce", "shop_defense_cap",
               "vault_break_rate", "vault_break_ratio",
               "vault_break_destroy"] },
      { title: "商店列表（按类型分开看）",
        type: "data-selector",
        keys: ["shop_food", "shop_weapon", "shop_vault", "shop_list"] },
      { title: "🍖 食物怎么配（1.7.7 新增）", type: "hint", tone: "tip", text:
        "🍖 **食物** —— 用来恢复体力，是**消耗品**（可反复购买）\n" +
        "　 在上面「商店列表」里切到 **🍖 食物（恢复体力）** 那一栏维护\n" +
        "\n" +
        "⚙️ **要填的字段**\n" +
        "· `name`　食物名（玩家用这个名字吃）\n" +
        "· `price`　价格（花积分买）\n" +
        "· `kind`　**必须填 `food`** —— 只有 food 才会进背包、可重复买\n" +
        "· `stamina_restore`　恢复多少体力\n" +
        "　 留空 = 用「体力系统」页的 `stamina_food_restore`（默认 30）\n" +
        "· `desc`　描述（可选）\n" +
        "\n" +
        "🎮 **玩家怎么用**\n" +
        "· 买：`购买商品 面包`（可反复买，进背包）\n" +
        "· 买多个：`购买商品 面包 3` 一次买 3 个（只有食物支持）\n" +
        "· 看背包：`吃食物`（不带参数就是列背包 + 当前体力）\n" +
        "· 吃 1 个：`吃食物 面包` 或 `吃食物 1`\n" +
        "· 吃多个：`吃食物 面包 3` 或 `吃食物 1 3`\n" +
        "· 全吃完：`吃食物 全部`\n" +
        "· 规则：**最后一个纯数字才是数量**，所以「吃食物 3」是\n" +
        "　 吃**第 3 种**食物 1 个，不会误解成吃 3 个\n" +
        "· 体力满了会**自动停**（不会浪费食物）\n" +
        "\n" +
        "💡 指令名可在「体力系统 · 加班与指令」里改（`food_eat_trigger_names`）" },
      { title: "怎么用", type: "hint", tone: "tip", text:
        "🛒 **签到商店** —— 三类东西都用「商店列表」维护\n" +
        "　 `kind` 填 `vault`=保险箱 / `weapon`=武器 / `food`=食物\n" +
        "\n" +
        "🍖 **食物**（`kind=food`，消耗品可重复买）\n" +
        "　 · 买进背包；吃一个恢复 `stamina_restore` 体力\n" +
        "　 · 吃法：「吃食物 名字」「吃食物 名字 3」「吃食物 全部」\n" +
        "　 · ⚠️ `kind` 不填 food 就会被当成**一次性买断的武器**\n" +
        "\n" +
        "🧰 **保险箱**（`kind=vault`，玩家买一次永久有效）\n" +
        "　 · 「签到统计」里会显示一行 `保险箱：金额`（没买不显示）\n" +
        "　 · 钱可以**存进保险箱** —— 存进去的部分**别人偷不走**\n" +
        "　 · 被偷概率降低 `vault_steal_reduce`（默认 15%）\n" +
        "　 · 玩家用「存钱 / 取钱」指令存取（金额写「全部」也可以）\n" +
        "\n" +
        "⚔️ **武器**（`kind=weapon`，玩家买一次永久加成）\n" +
        "　 · `steal_bonus` 提高**他偷别人**的成功率\n" +
        "　 · `defense_bonus` 降低**别人偷他**的成功率\n" +
        "　 · 防御加成总和最多叠到 `shop_defense_cap`（默认 60%）\n" +
        "\n" +
        "📌 实际偷积分成功率 = `steal_success_rate` + 坐骑加成 + 武器加成" +
        " − 对方防御\n" +
        "　 结果会夹在 0~100 之间（不会变成负数或超过 100）" },
    ],
  },
  pet: {
    title: "宠物功能",
    groups: [
      { title: "功能开关", keys: ["pet_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["pet_groups"] },
      { title: "指令配置 · 基础", keys: ["cmd_pet_buy_names", "cmd_pet_mine_names", "cmd_pet_sell_names", "cmd_pet_release_names", "cmd_pet_shop_names"] },
      { title: "指令配置 · 玩法", keys: ["cmd_pet_adventure_names", "cmd_pet_view_names", "cmd_pet_rest_names", "cmd_pet_duel_names", "cmd_pet_work_names"] },
      { title: "指令配置 · 管理员", keys: ["cmd_pet_add_names", "cmd_pet_del_names"] },
      { title: "指令配置 · 决斗 / 查宠物",
        keys: ["cmd_pet_duel_names", "cmd_pet_his_names"] },
      { title: "宠物决斗怎么用", type: "hint", tone: "tip", text:
        "⚔️ **宠物决斗** —— 三种写法\n" +
        "· `宠物决斗 @某人` = 双方**随机**各出一只\n" +
        "· `影 宠物决斗 @某人` = 指定**自己的**宠物（对方随机）\n" +
        "· `影 宠物决斗 @某人 雷龙` = **双方都指定**\n" +
        "（「影」「雷龙」是宠物名，换成你自己的）\n" +
        "\n🐾 **他的宠物 @某人** —— 列出对方在这个群的所有宠物" +
        "（按战力排序）\n" +
        "\n指定了不存在的宠物会提示，不会静默换别的。" },
      { title: "指令配置 · 物品", keys: ["cmd_item_shop_names", "cmd_item_buy_names", "cmd_item_use_names"] },
      { title: "🧭 菜单入口名（1.7.7，改了立刻生效）",
        keys: ["menu_pet_names", "menu_pet_care_names",
               "menu_pet_fight_names", "menu_pet_item_names"] },
      { title: "入口名怎么用", type: "hint", tone: "tip", text:
        "🧭 **改完立刻生效**（不用重载插件）：群里发新名字就能打开，\n" +
        "　 菜单里显示的入口名也同步跟着变。\n" +
        "· 可填**多个名字**，英文逗号分隔（都认）；留空 = 用默认名\n" +
        "· 改过名后**旧名字仍然可用**\n" +
        "· ⚠️ 别和别的**指令**重名" },
      { title: "冷却时间（小时）", keys: ["pet_cd_adventure_hours", "pet_cd_rest_hours", "pet_cd_work_hours", "pet_cd_duel_hours"] },
      { title: "随机规则", keys: ["pet_elem_random_on_buy"] },
      { title: "数值配置", keys: ["pet_exp_per_level", "pet_adventure_exp_min", "pet_adventure_exp_max", "pet_adventure_mp_cost", "pet_adventure_hp_cost", "pet_levelup_card_rate", "pet_counter_bonus"] },
      { title: "宠物数据列表", type: "data-selector",
      keys: ["pet_list", "pet_work_events", "pet_adventure_events",
             "pet_item_list"] },
      { title: "上班事件说明（1.7.6 已扩充涨价）", type: "hint", tone: "info", text:
        "· 内置 **120 个**上班事件，每个都配了 `经验区间` 和 `积分区间`\n" +
        "· 上班时**随机抽一个事件**，再在它的区间里随机取值\n" +
        "· ★ 共分 **6 个等级**，每档 20 个事件，**相邻等级涨约 1.6~1.7 倍**：\n" +
        "　 · 1 级 跑腿/服务　上限 **1200 ~ 1900**\n" +
        "　 · 2 级 普通打工　　上限 2000 ~ 3200\n" +
        "　 · 3 级 手艺活　　　上限 3600 ~ 5200\n" +
        "　 · 4 级 技术/体力　上限 6000 ~ 8400\n" +
        "　 · 5 级 高强度　　　上限 9600 ~ 13200\n" +
        "　 · 6 级 高危/特殊　上限 15000 ~ 21000\n" +
        "· **最低的事件上限也有 1200**，不会再抠\n" +
        "· `exp_min/exp_max` = 经验范围，`score_min/score_max` = 积分范围\n" +
        "· 想更赚：把 `score_max` 直接调大即可，**即时生效**（不用刷新）\n" +
        "· 想恢复内置默认：把 `pet_work_events` 列表清空保存，再重载插件\n" +
        "· ⚠️ 如果你自己增删改过这个列表，升级时**不会覆盖你的内容**" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 宠物功能` / `开启功能 宠物功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  fortune: {
    title: "今日运势",
    groups: [
      { title: "功能开关", keys: ["fortune_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["fortune_groups"] },
      { title: "指令配置", keys: ["fortune_trigger_names"] },
      { title: "运势内容列表", type: "data-selector", keys: ["fortune_list"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 今日运势` / `开启功能 今日运势`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  husband: {
    title: "今日老公",
    groups: [
      { title: "功能开关", keys: ["husband_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["husband_groups"] },
      { title: "指令配置", keys: ["husband_trigger_names", "husband_force_trigger_names"] },
      { title: "随机抽取选项", keys: ["husband_allow_bot", "husband_exclude_ids"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 今日老公` / `开启功能 今日老公`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  luck: {
    title: "今日人品",
    groups: [
      { title: "功能开关", keys: ["luck_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["luck_groups"] },
      { title: "指令配置", keys: ["luck_trigger_names"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 今日人品` / `开启功能 今日人品`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  entertain: {
    title: "娱乐功能",
    groups: [
      { title: "菜单入口", keys: ["cmd_entertain_menu"] },
      { title: "天气查询 · 菜单入口指令", keys: ["cmd_weather_menu"] },
      { title: "名片功能", keys: ["cmd_card_menu", "cmd_card"] },
      { title: "名片功能 · 性别符号样式（♂/♀ 的样子）",
        keys: ["cmd_card_gender_style"] },
      { title: "名片功能 · 群号黑名单（留空=所有群都生效）",
        keys: ["card_groups"] },
      { title: "查询功能（QQ 用户信息）",
        keys: ["qqinfo_enable"] },
      { title: "查询功能 · 群号黑名单（留空=所有群都生效）",
        keys: ["qqinfo_groups"] },
      { title: "查询功能 · 指令配置",
        keys: ["cmd_qqinfo", "cmd_qqinfo_menu"] },
      { title: "名片性别符号样式怎么选", type: "hint", tone: "tip", text:
        "名片右上角头像下方会画一个性别符号：**♂ 青蓝** / **♀ 少女粉**" +
        "（性别取不到时画灰色 ?）。\n" +
        "上面下拉可换样式，**保存后立刻生效**，不用重启服务：\n" +
        "· **v1 标准** —— 均衡耐看\n" +
        "· **v2 小巧** —— 给「最高等级小鸟」留更多空间（当前默认）\n" +
        "· **v3 醒目** —— 最大最粗，但离小鸟较近\n" +
        "· **v4 纤细** —— 线条更细更精致\n" +
        "· **v5 实心圆** —— 圆形填充实心，视觉最重\n" +
        "· **v6 靠下** —— 离头像更远、离小鸟更近\n" +
        "· **v7 迷你** —— 最小，不占地方\n" +
        "· **v8 大实心** —— 又大又是实心\n" +
        "换完样式后，旧的名片图会**自动重新渲染**（缓存已带样式标记）。" },
      { title: "查询功能怎么用", type: "hint", tone: "tip", text:
        "🔍**查询** —— 查 QQ 用户资料（输出**带头像的图片**）\n" +
        "· `查询 @某人` 或 `查询 QQ号`\n" +
        "· **必须带 @某人 或 QQ号** —— 光发「查询」不触发" +
        "（这词太常见，避免群里随便一句话就出图）\n" +
        "· 指令名可在上面「指令配置」里改（默认 查询 / 查QQ / 查qq / 查用户）\n" +
        "\n**输出内容**（文本模式与图片模式相同）\n" +
        "🖼 头像（仅图片模式，画在最顶部）\n" +
        "QQ昵称（太长省略号…）/ QQ等级\n" +
        "QID / QQ签名\n" +
        "注册时间 / 注册天数（≈N年）\n" +
        "会员等级 / 会员现状\n" +
        "\n**输出方式跟随本群「输出模式」**：\n" +
        "· 文本模式 → 发文字\n" +
        "· 图片模式 → 发带头像的卡片\n" +
        "\n资料由协议端（NapCat）提供。\n" +
        "· **只显示查到的项**：对方隐私严格、或协议端没返回的字段" +
        "会**自动省略**（所以卡片有长有短，不是被截断）\n" +
        "· 想看缺哪项：看日志里的 `[qqinfo] ... 原始响应`\n" +
        "· **功能开关**：关掉后完全不响应查询指令\n" +
        "· **群号黑名单**：填了群号 = 这些群不生效\n" +
        "· 也可以在群里发 `关闭功能 查询功能` 关掉本群" },
      { title: "猜拳功能", keys: ["rps_enable"] },
      { title: "猜拳功能 · 群号黑名单（留空=所有群都生效）",
        keys: ["rps_groups"] },
      { title: "猜拳功能 · 指令配置",
        keys: ["cmd_rps", "cmd_rps_menu"] },
      { title: "猜拳功能 · 积分规则",
        keys: ["rps_bet_max", "rps_daily_limit", "rps_allow_negative"] },
      { title: "🔢 猜数游戏 · 开关与指令（1.7.7 新增）",
        keys: ["guess_enable", "cmd_guess_start", "cmd_guess",
               "cmd_guess_menu", "guess_groups"] },
      { title: "🔢 猜数游戏 · 规则与积分",
        keys: ["guess_min", "guess_max", "guess_max_tries",
               "guess_timeout_sec", "guess_reward_min",
               "guess_reward_max", "guess_penalty",
               "guess_allow_negative"] },
      { title: "猜数游戏怎么用（1.7.7 重写）", type: "hint", tone: "tip", text:
        "🔢 **猜数游戏**（娱乐功能子菜单）—— 群内**多人抢猜**\n" +
        "\n🎮 **两条指令**\n" +
        "· `开始猜数` → 开一局，机器人想一个「下限 ~ 上限」之间的整数\n" +
        "　 **所有人都能参与**，不是单人游戏\n" +
        "· `猜数 50` → 参与猜一次，回你「太大了 / 太小了 / 猜对了」\n" +
        "\n📏 **规则**（全部在上面改）\n" +
        "· `guess_max_tries` = 每人每局最多猜几次（默认 3）\n" +
        "· `guess_timeout_sec` = **多少秒没人猜**就关闭这局\n" +
        "　 默认 60 秒；**每次有人猜都重新计时**；填 0 = 永不自动关\n" +
        "· `guess_reward_min` ~ `guess_reward_max` = 猜对奖励区间\n" +
        "　 真猜对时在区间里**随机**给一个金额（默认 100~500）\n" +
        "· `guess_penalty` = **猜错扣多少**（默认 1000，填 0 = 不扣）\n" +
        "　 ⚠️ 每猜错一次就扣一次\n" +
        "· `guess_allow_negative` = 关掉后积分不够就猜不了\n" +
        "\n💡 谁先猜中谁赢，这一局立刻结束；超时没人猜中则直接作废（不扣不奖）。\n" +
        "💡 两个指令名都能改：`cmd_guess_start` / `cmd_guess`。" },
      { title: "功能说明", type: "hint", tone: "tip",
        text: "🎈 娱乐功能现有子菜单：\n" +
              "· 📇 名片功能 —— 生成群名片\n" +
              "· ✊ 猜拳功能 —— 和群友猜拳赢积分\n" +
              "\n【猜拳】用法：\n" +
              "· 「猜拳功能」→ 看猜拳菜单（指令名在上面改）\n" +
              "· 「猜拳」→ 不带手势时也进菜单\n" +
              "· 「猜拳 石头」→ 群里随机找一个人猜拳\n" +
              "· 「猜拳 石头 @某人」→ 和指定的人猜拳\n" +
              "· 手势：石头 / 剪刀 / 布（也认剪子、包袱、rock/scissors/paper）\n" +
              "· 赢了拿随机积分，输了扣同样的分给对方；平局双方不变\n" +
              "· 积分范围 1 ~ 「单局积分上限」；允许扣成负分时可变负数\n" +
              "\n【名片】用法：\n" +
              "· 「名片」→ 自己的；「名片 @某人」→ 对方的；「名片 QQ号」→ 指定 QQ\n" +
              "· 名片固定为图片输出，不受「输出模式」影响\n" +
              "\n★ 想改「猜拳功能」菜单里显示的文字："
              + "  到「菜单指令」页 → 菜单输出内容 → 选「猜拳功能」。" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 猜拳功能` / `开启功能 猜拳功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  bird: {
    title: "小鸟图鉴",
    groups: [
      { title: "功能开关", keys: ["bird_enable"] },
      { title: "指令配置",
        keys: ["cmd_bird_menu", "cmd_bird", "cmd_gallery",
               "cmd_bird_list", "cmd_bird_view", "bird_list_per_page"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["bird_groups"] },
      { title: "素材目录", keys: ["bird_image_dir"] },
      { title: "图片自动识别", type: "birdstatus" },
      { title: "小鸟列表", type: "data-selector", keys: ["bird_list"] },
      { title: "说明", type: "hint", tone: "info",
        text: "🐦 小鸟图鉴用法：\n" +
              "· 「小鸟图鉴」→ 打开这个菜单\n" +
              "· 「今日小鸟」→ 抽一只小鸟（每人每天一次）\n" +
              "· 「我的图鉴」→ 查看收集进度（一行 10 个，每页 60 只）\n" +
              "· 「图鉴列表」→ 按编号列出全部小鸟（带页码翻页）\n" +
              "· 「图鉴查看 编号」→ 看这只鸟的详细资料（也可直接写名字）\n" +
              "\n★ 收集进度**全群共享**：同一个人在任何群看到的都是同一份。\n" +
              "\n★ 四个图鉴指令（菜单/抽鸟/我的图鉴/图鉴列表/图鉴查看）" +
              "**共用同一份群黑名单**。\n" +
              "\n加小鸟：点下面「+ 新增一条」，填中文名、英文名、" +
              "保护等级、简介即可，\n" +
              "图片自动去「小鸟图片目录」里找同名文件（中文名「仓鸮」→ 仓鸮.png）。\n" +
              "\n小鸟等级上限 100；已拥有的右上角显示等级数字，未拥有显示锁。\n" +
              "\n【总开关】关闭后所有群都不能用；" +
              "【黑名单】填了群号，只有这些群不能用。" +
              "\n群内「关闭功能 小鸟图鉴」会自动把本群号加进黑名单。" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 小鸟图鉴` / `开启功能 小鸟图鉴`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  news: {
    title: "每日读报",
    groups: [
      { title: "功能开关", keys: ["daily_news_enable"] },
      { title: "手动读报不生效的群号（留空=所有群都能用）", keys: ["daily_news_groups"] },
      { title: "自动推送的群号（必填，留空=不推送）", keys: ["daily_news_auto_groups"] },
      { title: "定时推送", keys: ["daily_news_time", "daily_news_interval"] },
      { title: "指令配置", keys: ["cmd_daily_news", "cmd_daily_news_on", "cmd_daily_news_off", "cmd_daily_news_time", "cmd_daily_news_list"] },
      { title: "生效群号怎么用（白名单）", type: "hint", tone: "warn", text:
        "· 这个功能是**白名单**：**必须填群号才会生效**，留空 = 全都不生效\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里发 `关闭功能 读报功能`（把本群移出名单）\n" +
        "　 或 `开启功能 读报功能`（把本群加进名单）\n" +
        "· 想看某个群的生效情况：发 `功能状态`" },
    ],
  },
  chime: {
    title: "整点报时",
    groups: [
      { title: "功能开关", keys: ["hourly_chime_enable"] },
      { title: "生效的群号（必填，留空=不报时）", keys: ["hourly_chime_groups"] },
      { title: "参数配置", keys: ["hourly_chime_interval", "hourly_chime_template"] },
      { title: "💬 第二行「每日一言」（默认关闭，想加再打开）", keys: ["hourly_chime_yiyan_enable", "hourly_chime_yiyan_api", "hourly_chime_yiyan_prefix", "hourly_chime_yiyan_timeout"] },
      { title: "图片模式卡片宽度（1.7.6 新增）", keys: ["hourly_chime_card_max_w"] },
      { title: "每日一言说明", type: "hint", tone: "info", text:
        "· 整点报时**第一行**报时、**第二行**每日一言\n" +
        "· 接口返回**纯文本**即可（默认那个直接返回一句话）\n" +
        "· 返回内容会压成**单行**、自动去掉引号\n" +
        "· 接口失败/超时 → 只发第一行，**不影响报时**\n" +
        "· 第一行想**不换行**就把文案写短一点，例：`🕐 现在是 {hour} 点整`" },
      { title: "指令配置", keys: ["cmd_chime_on", "cmd_chime_off", "cmd_chime_status", "cmd_chime_hours", "cmd_chime_text", "cmd_chime_list", "cmd_chime_test"] },
      { title: "生效群号怎么用（白名单）", type: "hint", tone: "warn", text:
        "· 这个功能是**白名单**：**必须填群号才会生效**，留空 = 全都不生效\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里发 `关闭功能 整点报时`（把本群移出名单）\n" +
        "　 或 `开启功能 整点报时`（把本群加进名单）\n" +
        "· 想看某个群的生效情况：发 `功能状态`" },
    ],
  },
  word: {
    title: "词库系统",
    groups: [
      { title: "功能开关", keys: ["word_reply_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["word_reply_groups"] },
      { title: "指令配置", keys: ["cmd_word_add", "cmd_word_del", "cmd_word_list"] },
      { title: "词库列表", type: "data-selector", keys: ["word_reply_list"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 词库系统` / `开启功能 词库系统`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
      { title: "👉 戳一戳随机回复（1.7.8 新增）", type: "goto-page",
        view: "poke", style: "primary",
        label: "➡️ 去「戳一戳回复」页设置",
        desc: "总开关 / 限频 / 群黑名单 / 回复词库 都在那个页面里改。"
              + "　（左侧导航也有独立入口「👉 戳一戳回复」，不弹窗）" },
      { title: "戳一戳怎么用", type: "hint", tone: "tip", text:
        "👉 **戳一戳随机回复**（1.7.8 新增）\n" +
        "· 别人**戳一戳机器人**（双击头像），随机回一句词\n" +
        "· 词库、总开关、限频、群黑名单 → 点上面的按钮进**专属设置页**改\n" +
        "· 默认限频 **60 秒内最多 5 次**，★ **所有群一起算**（全局限频）\n" +
        "　 超出后**静默不回复**，不打扰群；填 0 = 不限频\n" +
        "\n⚠️ 需要协议端支持 poke 事件（NapCat / OneBot v11 均可）。\n" +
        "💡 想确认能不能收到事件：打开「群事件提示」的调试模式戳一下看看。" },
    ],
  },
  // ★★ 1.7.8：**戳一戳回复** —— 左侧导航独立按钮，点开就是完整表单
  //   （和「词库系统」「发言统计」一样是面板内联页，**不弹窗**）
  poke: {
    title: "戳一戳回复",
    groups: [
      { title: "⚙️ 总开关", keys: ["poke_reply_enable"] },
      { title: "⏱️ 限频（默认 60 秒内最多 5 次）", keys: [
          "poke_reply_window_sec", "poke_reply_max_per_window"] },
      { title: "限频说明", type: "hint", tone: "info", text:
        "⏱️ **限频怎么算**\n" +
        "· `限频窗口`（默认 **60** 秒）+ `窗口内最多回复几次`（默认 **5**）\n" +
        "· ★ 口径是**全局**：**所有群一起算**，不是每群各算 5 次\n" +
        "· 超出后**静默不回复**，不打扰群；`次数填 0` = 不限频\n" +
        "· 窗口是**滑动**的：最早那次回复过了窗口时间就自动释放名额" },
      { title: "🎯 触发范围", keys: ["poke_reply_only_self"] },
      { title: "🚫 群号黑名单（留空 = 所有群都生效）",
        keys: ["poke_reply_groups"] },
      { title: "📚 戳一戳回复词库（一条一句，随机抽）",
        type: "data-selector", keys: ["poke_reply_list"] },
      { title: "当前生效的规则（只读）", type: "ro-status" },
      { title: "戳一戳怎么用", type: "hint", tone: "tip", text:
        "👉 **戳一戳随机回复**（1.7.8 新增）\n" +
        "· 别人**戳一戳机器人**（双击头像）→ 随机回一句词\n" +
        "· 词库留空时用**内置兜底文案**（戳了不会没反应）\n" +
        "· 「只在戳机器人自己时回复」关掉后：任何人戳任何人都回\n" +
        "· 回复走统一输出通道，**图片模式（含白底黑字）与回复尾巴自动生效**\n" +
        "\n⚠️ 需要协议端支持 poke 事件（NapCat / OneBot v11 均可）。\n" +
        "💡 想确认能不能收到事件：打开「群事件提示」的调试模式戳一下看看。" },
      { title: "改完记得保存", type: "hint", tone: "warn", text:
        "💾 改完点右上角「**保存全部**」写入（词库改动也一起保存）。" },
    ],
  },
  speak: {
    title: "发言统计",
    groups: [
      { title: "功能开关", keys: ["speak_stats_enable"] },
      { title: "群号黑名单（留空=所有群都生效）", keys: ["speak_stats_groups"] },
      { title: "指令配置", keys: ["cmd_speak_rank_names", "cmd_active_rank_names", "cmd_week_rank_names", "cmd_month_rank_names", "cmd_my_speak_names"] },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 发言功能` / `开启功能 发言功能`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },
  status: {
    title: "电脑状态",
    groups: [
      { title: "功能开关", keys: ["status_feature_enable"] },
      { title: "不生效的群号（留空=所有群都能查）", keys: ["status_groups"] },
      { title: "指令配置", keys: ["cmd_status"] },
      { title: "机器人QQ（自动记录）", keys: ["bot_self_id"] },
      { title: "显示内容 · 基础信息总开关",
        keys: ["cmd_status_show_basic"] },
      { title: "显示内容 · 基础信息（每项单独开关）",
        keys: ["cmd_status_show_gid", "cmd_status_show_bot_qq",
               "cmd_status_show_msg_stats", "cmd_status_show_time"] },
      { title: "显示内容 · 版本总开关", keys: ["cmd_status_show_version"] },
      { title: "显示内容 · 版本（6 个可单独开关）",
        keys: ["cmd_status_show_ver_plugin", "cmd_status_show_ver_astrbot",
               "cmd_status_show_ver_framework", "cmd_status_show_ver_napcat",
               "cmd_status_show_ver_pcqq", "cmd_status_show_ver_os"] },
      { title: "🔧 框架版本 · 自定义主程序路径（留空自动探测萌QNT/NapCatQQ）",
        keys: ["framework_version_exe"] },
      { title: "显示内容 · 硬件总开关",
        keys: ["cmd_status_show_uptime", "cmd_status_show_cpu",
               "cmd_status_show_mem", "cmd_status_show_disk",
               "cmd_status_show_net", "cmd_status_show_traffic",
               "cmd_status_show_gpu"] },
      { title: "显示内容 · CPU（每项独立开关，需 CPU 总开关打开）",
        keys: ["cmd_status_show_cpu_load_rate", "cmd_status_show_cpu_cores",
               "cmd_status_show_cpu_clock", "cmd_status_show_cpu_cores_load",
               "cmd_status_show_cpu_load", "cmd_status_show_cpu_temp",
               "cmd_status_show_cpu_power", "cmd_status_show_cpu_voltage",
               "cmd_status_show_cpu_fan"] },
      { title: "🔌 硬件数据源", type: "hint", tone: "info", text:
        "★ 本版本的硬件数据**全部由 psutil 提供**（AstrBot 运行环境自带），\n" +
        "**不需要任何外部监控服务**，也没有对应的配置项。\n\n" +
        "· CPU 占用 / 频率 / 分核占用、内存占用、硬盘占用、开机时长、网络速率\n" +
        "  → 均由 psutil 直接读取\n" +
        "· ⚠️ **CPU 温度 / 功耗 / 电压 / 风扇**、**今日流量统计** 本版本**不提供**\n" +
        "  （Windows 上 psutil 拿不到这些数据）—— 对应开关打开时该项不显示" },
      { title: "标题与末尾附加",
        keys: ["cmd_status_tail"] },
      { title: "自动推送的群号（必填，留空=不推送）", keys: ["daily_status_push_groups"] },
      { title: "定时推送 · 推送间隔（分钟）", keys: ["daily_status_push_interval_min"] },
      { title: "定时推送 · 指令配置", keys: ["cmd_daily_push_on", "cmd_daily_push_off", "cmd_daily_push_time", "cmd_daily_push_list"] },
      { title: "输出顺序怎么排", type: "hint", tone: "info", text:
        "状态信息从上到下固定这个顺序：\n" +
        "标题 → 当前群群号 → 机器人QQ → 各版本（插件/AstrBot/NapCat/" +
        "PCQQ/系统）→ 消息统计 → 开机时长 → CPU → 内存 → 硬盘 → " +
        "**北京时间（固定最下面）** → 末尾附加\n" +
        "把上面某个开关关掉，对应的行就不出现，其余顺序不变。" },
      { title: "输出预览与测试", type: "status-panel" },
      { title: "群号黑名单怎么用", type: "hint", tone: "info", text:
        "· **留空 = 所有群都生效**；填了群号 = 这些群**不生效**\n" +
        "· 多个群号用**英文逗号**隔开，例如：`123456,789012`\n" +
        "· 也可以在群里直接发 `关闭功能 电脑状态` / `开启功能 电脑状态`\n" +
        "　 指令一发，本群号会**自动写进/移出**上面这个黑名单，后台立刻能看到\n" +
        "· 想看某个群到底开着哪些功能：发 `功能状态`" },
    ],
  },

  data: {
    title: "数据管理",
    groups: [
      { title: "数据管理", type: "data-manager" },
      // 接口规则整份（不分类型），其余集合各自的按钮在对应功能页里
      { title: "接口规则（全部类型）",
        keys: ["api_list"] },
    ],
  },
  admin: {
    title: "管理系统",
    groups: [
      { title: "整体说明", type: "hint", tone: "info", text:
        "· 这里是全局设置：输出模式、数据备份/导入、插件管理员等\n" +
        "· **功能开关**请到左侧对应的功能页配置\n" +
        "· 每个功能页都有一个「群号黑名单」，也可以直接在群里发\n" +
        "　 `关闭功能 功能名` / `开启功能 功能名` 远程开关，后台会自动同步\n" +
        "· 查看某个群的开关状态：发 `功能状态`" },
      { title: "指令配置", keys: ["cmd_enable", "cmd_disable", "cmd_enable_feature", "cmd_disable_feature", "cmd_feature_status"] },
      { title: "必须艾特机器人", keys: ["must_at_bot", "cmd_must_at_bot_on", "cmd_must_at_bot_off", "cmd_must_at_bot_status"] },
      { title: "管理员设置", keys: ["cmd_view_admin", "cmd_refresh_admin", "cmd_add_admin", "cmd_del_admin", "cmd_admin_list", "plugin_admins", "group_admin_cache_ttl"] },
      { title: "接口安全（Web 写操作令牌）", keys: ["web_admin_token"] },
      { title: "💬 全局回复尾巴（1.7.6 新增）", keys: ["reply_tail_enable", "reply_tail_mode", "reply_tail_text", "reply_tail_api", "reply_tail_prefix", "reply_tail_timeout", "reply_tail_sep", "reply_tail_only_group", "reply_tail_max_len"] },
      { title: "回复尾巴说明", type: "hint", tone: "warn", text:
        "· 作用：本插件的**所有回复**末尾自动追加一段尾巴\n" +
        "· **不填内容就完全没有尾巴** —— 三个来源都是空的就什么都不加\n" +
        "　 ① 固定文字 `reply_tail_text`\n" +
        "　 ② 文本接口 `reply_tail_api`（每次取一段，默认每天一言那个接口）\n" +
        "　 ③ `reply_tail_mode` 决定用哪个：`text` / `api` / `both`\n" +
        "· 接口返回**纯文本**即可；会压成单行、去引号、按 `reply_tail_max_len` 截断\n" +
        "· 接口失败/超时 → 跳过尾巴，**不影响正常回复**\n" +
        "· 只给**本插件自己发的**回复加（靠输出里的「鸡鸡娱乐系统：」标记识别），\n" +
        "　 不会影响其他插件和 LLM 的回复\n" +
        "· 默认只在**群聊**追加（`reply_tail_only_group` 关掉则私聊也加）\n" +
        "· 例：`reply_tail_mode=api` + `reply_tail_api` 填每日一言地址 → 每条回复末尾带一句话" },
      { title: "全局群号黑名单（留空=所有群都生效）", keys: ["global_groups"] },
      { title: "已关闭的群", keys: ["disabled_groups"] },
  { title: "输出模式（文本 / 卡片 / 图片）", keys: ["output_mode_enable",
      "output_default_mode", "cmd_output_mode", "output_render_base",
      "output_bg_image",
      "output_card_title", "output_group_modes"] },
      { title: "群员管理（踢出 / 禁言 / 拉黑）", keys: ["moderation_enable", "mute_duration", "blacklist_default_action", "member_blacklist"] },
      { title: "群员管理指令", keys: ["cmd_kick", "cmd_mute", "cmd_unmute", "cmd_blacklist", "cmd_unblacklist", "cmd_blacklist_list"] },
      { title: "🔔 提示功能（1.7.6 新增）", type: "hint", tone: "info", text:
        "★ **白名单**语义：每一类提示各自一份群号清单，**填了就只在这些群提示**\n" +
        "★ **留空 = 该类全部关闭**（安装后默认全部是空的，即默认全关）" },
      { title: "提示功能：群号白名单（留空=关闭）", keys: [
          "notice_groups_card", "notice_groups_mute", "notice_groups_leave",
          "notice_groups_admin", "notice_groups_title"] },
      { title: "提示功能：各类开关指令短名（只影响显示）", keys: [
          "notice_cmd_card", "notice_cmd_mute", "notice_cmd_leave",
          "notice_cmd_admin", "notice_cmd_title"] },
      { title: "提示功能：各类输出内容（可自定义）", type: "hint", tone: "info",
        text: "占位符写法：`$名字`，也兼容 `{名字}`\n" +
              "· 通用：`$user` 成员名　`$uid` / `$qq` QQ号　`$time` 时间　`$group` 群号\n" +
              "· 改群昵称：`$old` 旧　`$new` 新\n" +
              "· 禁言/解禁：`$duration` 时长　`$kind` 禁言或解禁　`$operator` 操作人\n" +
              "· 退群/被踢：`$action` 主动退群或被踢出\n" +
              "· 管理员：`$action` 成为管理员或被取消管理员\n" +
              "· 专属称号：`$title` 新称号（取消时显示「已取消」）\n" +
              "未提供的占位符会**原样保留**，方便对照排查。" },
      { title: "提示功能：输出内容", keys: [
          "notice_text_card", "notice_text_mute", "notice_text_leave",
          "notice_text_admin", "notice_text_title"] },
      { title: "提示功能：说明见上方", type: "hint", tone: "info",
        text: "白名单在「提示功能：群号白名单（留空=关闭）」里填写。\n" +
              "群里发 `提示状态` 可以查本群在每个白名单里的命中情况。" },
      { title: "提示功能玩法说明", type: "hint", tone: "warn", text:
        "★ **白名单开关**：上面五个群号清单，各自控制一类提示\n" +
        "· 例：`lottery... notice_groups_mute` 里填 `123456,789012`\n" +
        "　 → 只在这两个群提示「谁被禁言/解禁」\n" +
        "· **留空 = 该类全部关闭**；五类都留空 = 提示功能完全关闭\n" +
        "· **默认全部关闭**，装好后什么都不发，需要你填群号才会启用\n" +
        "\n★ 五类提示：\n" +
        "· 改群昵称　　谁改了群昵称\n" +
        "· 禁言/解禁　谁被禁言、谁被解禁\n" +
        "· 退群/被踢　谁退群、谁被踢出（附剩余人数）\n" +
        "· 管理员　　谁成为 / 被取消管理员\n" +
        "· 专属称号　谁获得 / 被取消专属称号\n" +
        "\n★ 群里可以查：发 `提示状态` 看本群在哪几类白名单里\n" +
        "\n★ 数据来源：**NapCat / OneBot v11 的 notice 事件推送**（实时）\n" +
        "· 需要协议端把「群事件」推送打开；机器人要有相应权限\n" +
        "· 昵称渲染优先用事件里带的昵称，缺失时用内存缓存，再缺就显示 QQ 号" },
    ],
  },
};

// ============================================================
// 电脑状态：预览 + 测试推送
// ============================================================
function buildStatusPanelHtml() {
  return `<div class="status-panel">
    <div class="status-panel-head">
      <span class="status-panel-title">当前状态输出预览</span>
      <span class="status-panel-actions">
        <button class="btn btn-info btn-sm" id="refreshStatusBtn">🔄 刷新预览</button>
        <button class="btn btn-primary btn-sm" id="testPushBtn">🚀 测试推送</button>
      </span>
    </div>
    <pre class="status-preview" id="statusPreview">点击「刷新预览」查看当前配置下的实际输出</pre>
    <div class="status-panel-hint" id="statusPushResult"></div>
    <div class="status-panel-hint">
      预览与测试推送都会<strong>叠加当前表单里未保存的修改</strong>，方便先看效果再保存。
      测试推送需要目标群已记录过 UMO（该群发过任意一条消息）。
    </div>
  </div>`;
}

async function fetchStatusPreview() {
  const box = $("statusPreview");
  if (!box) return;
  box.textContent = "加载中...";
  const hint = $("statusPushResult");
  if (hint) hint.textContent = "";

  const applyResult = (res) => {
    if (res && res.ok && res.text) {
      box.textContent = res.text;
      if (hint) hint.textContent = `📄 预览来源：${res.group_id ? `群 ${res.group_id}` : "无群上下文"}`;
      return true;
    }
    return false;
  };

  // ① 桥接优先
  if (bridgeReady && bridge && typeof bridge.apiGet === "function") {
    try {
      const res = await Promise.race([
        bridge.apiGet("previewStatus"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("bridge.apiGet 超时")), 3000)
        ),
      ]);
      if (applyResult(res)) return;
    } catch (e) {
      console.warn("[status] 桥接预览失败，降级 fetch:", e);
    }
  }

  // ② fetch 兜底
  for (const url of buildRouteUrls("previewStatus")) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) continue;
      if (applyResult(await r.json())) return;
    } catch (e) {
      console.warn(`[status] fetch ${url} 失败:`, e);
    }
  }

  box.textContent = "获取失败，请检查桥接是否可用或后端状态模块是否加载";
}

async function onTestPush() {
  const btn = $("testPushBtn");
  const out = $("statusPushResult");
  if (btn) { btn.disabled = true; btn.textContent = "推送中..."; }
  if (out) out.textContent = "";

  // 带上当前表单值，让测试推送反映未保存的修改
  const payload = { data: collectFormData() };

  const finish = (res, err) => {
    if (err) {
      const msg = (err && err.message) || String(err);
      if (out) out.textContent = `❌ 推送失败：${msg}`;
      toast("推送失败，请查看控制台", "error");
      return;
    }
    if (res && res.ok) {
      if (out) out.textContent = `✅ 已推送到群 ${res.group_id || "?"}`;
      toast("✅ 测试推送成功");
    } else {
      const msg = (res && res.msg) || "未知错误";
      if (out) out.textContent = `❌ 推送失败：${msg}`;
      toast(`推送失败：${msg}`, "error");
    }
  };

  try {
    // ① 桥接优先
    let handled = false;
    if (bridgeReady && bridge && typeof bridge.apiPost === "function") {
      try {
        const res = await Promise.race([
          bridge.apiPost("testStatusPush", payload),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("bridge.apiPost 超时")), 15000)
          ),
        ]);
        console.log("[status] testStatusPush 返回:", res);
        finish(res, null);
        handled = true;
      } catch (e) {
        console.warn("[status] 桥接测试推送失败，降级 fetch:", e);
      }
    }

    // ② fetch 兜底
    if (!handled) {
      let done = false;
      let lastErr = null;
      for (const url of buildRouteUrls("testStatusPush")) {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload),
          });
          if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
          const j = await r.json();
          console.log(`[status] fetch ${url} 返回:`, j);
          finish(j, null);
          done = true;
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[status] fetch ${url} 失败:`, e);
        }
      }
      if (!done) finish(null, lastErr || new Error("全部通道失败"));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🚀 测试推送"; }
  }
}

// ============================================================
// 数据备份 / 导出
// ============================================================
function bytesText(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function setBackupResult(msg, type) {
  const el = $("backupResult");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `backup-result${type ? ` ${type}` : ""}`;
}

// 统一的「桥接优先 + fetch 兜底」请求
async function backupRequest(action, { method = "GET", body = null } = {}) {
  // ① 桥接
  if (bridgeReady && bridge) {
    try {
      if (method === "GET" && typeof bridge.apiGet === "function") {
        return await Promise.race([
          bridge.apiGet(action),
          new Promise((_, rj) => setTimeout(() => rj(new Error("bridge 超时")), 8000)),
        ]);
      }
      if (method === "POST" && typeof bridge.apiPost === "function") {
        return await Promise.race([
          bridge.apiPost(action, body || {}),
          new Promise((_, rj) => setTimeout(() => rj(new Error("bridge 超时")), 30000)),
        ]);
      }
    } catch (e) {
      console.warn(`[backup] 桥接 ${action} 失败，降级 fetch:`, e);
    }
  }
  // ② fetch 兜底
  let lastErr = null;
  for (const url of buildRouteUrls(action)) {
    try {
      const opt = { method, credentials: "same-origin" };
      if (method === "POST") {
        opt.headers = authHeaders({ "Content-Type": "application/json" });
        opt.body = JSON.stringify(body || {});
      }
      const r = await fetch(url, opt);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("请求失败");
}

// 导出弹窗：展示默认备份目录 + 数据文件清单
async function openExportModal() {
  const modal = $("exportModal");
  if (!modal) return;
  modal.classList.add("open");
  setBackupResult("");
  const filesEl = $("backupFiles");
  if (filesEl) filesEl.textContent = "读取中...";
  try {
    const res = await backupRequest("backupInfo");
    if (res && res.ok) {
      const dirEl = $("backupDefaultDir");
      if (dirEl) dirEl.textContent = res.default_dir || "（未知）";
      const input = $("backupDirInput");
      if (input && !input.value) input.placeholder = `留空使用：${res.default_dir || "默认目录"}`;
      if (filesEl) {
        const files = res.files || [];
        filesEl.innerHTML = files.map(f => {
          const tag = f.exists
            ? `<span class="ok">✔</span> ${esc(f.file)} <span class="miss">(${bytesText(f.size)})</span>`
            : `<span class="miss">✘ ${esc(f.file)}（暂无数据）</span>`;
          return `${tag}　${esc(f.label)}`;
        }).join("<br>");
      }
    } else {
      if (filesEl) filesEl.textContent = `读取失败：${(res && res.msg) || "未知错误"}`;
    }
  } catch (e) {
    console.warn("[backup] 读取备份信息失败:", e);
    if (filesEl) filesEl.textContent = "读取失败，请检查桥接或后端路由";
  }
}

function closeExportModal() {
  const modal = $("exportModal");
  if (modal) modal.classList.remove("open");
}

// 导入弹窗：清空上一次的结果，避免误导
function openImportModal() {
  const modal = $("importModal");
  if (!modal) return;
  modal.classList.add("open");
  setImportPreview("");
  setBackupResult("");
}

function closeImportModal() {
  const modal = $("importModal");
  if (modal) modal.classList.remove("open");
}

async function onDoBackup() {
  const btn = $("doBackupBtn");
  const input = $("backupDirInput");
  const target = (input && input.value.trim()) || "";
  if (btn) { btn.disabled = true; btn.textContent = "备份中..."; }
  setBackupResult("正在备份，请稍候...");
  try {
    const res = await backupRequest("backup", { method: "POST", body: { target_dir: target } });
    if (res && res.ok) {
      const n = (res.files || []).length;
      setBackupResult(`✅ ${res.msg}\n备份目录：${res.path}`, "ok");
      toast(`✅ 已备份 ${n} 个文件`);
    } else {
      setBackupResult(`❌ ${(res && res.msg) || "备份失败"}`, "err");
      toast("备份失败", "error");
    }
  } catch (e) {
    console.warn("[backup] 备份失败:", e);
    setBackupResult(`❌ 备份失败：${(e && e.message) || e}`, "err");
    toast("备份失败", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "备份到该目录"; }
  }
}

async function onDownloadBackup() {
  const btn = $("doDownloadBtn");
  if (btn) { btn.disabled = true; btn.textContent = "打包中..."; }
  setBackupResult("正在打包全部数据...");
  try {
    const res = await backupRequest("backupDownload");
    if (!res || !res.ok || !res.bundle) {
      setBackupResult(`❌ ${(res && res.msg) || "打包失败"}`, "err");
      return;
    }
    const text = JSON.stringify(res.bundle, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${PLUGIN_ID}_backup_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setBackupResult(`✅ 已导出 ${res.bundle.file_count} 个文件，请查看浏览器的下载目录`, "ok");
    toast("✅ 已开始下载备份");
  } catch (e) {
    console.warn("[backup] 下载失败:", e);
    setBackupResult(`❌ 下载失败：${(e && e.message) || e}`, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "下载 JSON 备份"; }
  }
}

// ============================================================
// 数据导入 / 还原
// ============================================================
function importCheckboxMergeSkip() {
  const cb = $("importMergeSkip");
  return !!(cb && cb.checked);
}

function setImportPreview(msg, type) {
  const el = $("importPreview");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = type === "err" ? "var(--danger)" : "var(--text-secondary)";
}

function setImportResult(msg, type) {
  const el = $("importResult");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `backup-result${type ? ` ${type}` : ""}`;
}

function renderImportPreview(res) {
  const el = $("importPreview");
  if (!el || !res) return;
  const files = res.files || [];
  const head = `${res.msg || ""}<br>来源：${esc(res.source || "")}<br><br>`;
  const body = files.map(f => {
    if (f.valid) {
      return `<span class="ok">✔</span> ${esc(f.file)} <span class="miss">(${bytesText(f.size)})</span>　${esc(f.label || "")}`;
    }
    return `<span class="miss">✘ ${esc(f.file)}　${esc(f.reason || "不可用")}</span>`;
  }).join("<br>");
  el.innerHTML = head + body;
}

async function onImportPreview() {
  const input = $("importSourceInput");
  const source = (input && input.value.trim()) || "";
  if (!source) {
    setImportPreview("请先填写备份目录或备份包路径", "err");
    return;
  }
  const btn = $("doImportPreviewBtn");
  if (btn) { btn.disabled = true; btn.textContent = "预检中..."; }
  setImportPreview("正在检查，请稍候...");
  try {
    const res = await backupRequest("importPreview", { method: "POST", body: { source } });
    if (res && res.ok) {
      renderImportPreview(res);
    } else {
      setImportPreview(`❌ ${(res && res.msg) || "预检失败"}`, "err");
    }
  } catch (e) {
    console.warn("[backup] 预检失败:", e);
    setImportPreview(`❌ 预检失败：${(e && e.message) || e}`, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "先预检"; }
  }
}

async function onDoImport() {
  const input = $("importSourceInput");
  const source = (input && input.value.trim()) || "";
  if (!source) {
    setImportPreview("请先填写备份目录或备份包路径", "err");
    return;
  }
  const mode = importCheckboxMergeSkip() ? "merge_skip" : "replace";
  const modeText = mode === "merge_skip" ? "仅补充缺失文件" : "覆盖导入";
  const _impGo = await uiConfirm(
    `确认以「${modeText}」方式导入？\n\n来源：${source}\n\n`
    + `导入前会自动备份当前数据，可随时回退。`,
    { okText: "开始导入", danger: false });
  if (!_impGo) {
    return;
  }

  const btn = $("doImportBtn");
  if (btn) { btn.disabled = true; btn.textContent = "导入中..."; }
  setImportResult("正在导入，请稍候...");
  try {
    const res = await backupRequest("importData", { method: "POST", body: { source, mode } });
    if (res && res.ok) {
      const n = (res.imported || []).length;
      const sk = (res.skipped || []).length;
      let text = `✅ ${res.msg}`;
      if (res.backup_dir) text += `\n导入前备份：${res.backup_dir}`;
      if (sk) {
        const names = (res.skipped || []).map(x => x.file).join("、");
        text += `\n跳过：${names}`;
      }
      text += `\n\n💡 数据已写入，刷新页面即可看到最新内容`;
      setImportResult(text, "ok");
      toast(`✅ 已导入 ${n} 个文件${sk ? `，跳过 ${sk} 个` : ""}`);
    } else {
      setImportResult(`❌ ${(res && res.msg) || "导入失败"}`, "err");
      toast("导入失败", "error");
    }
  } catch (e) {
    console.warn("[backup] 导入失败:", e);
    setImportResult(`❌ 导入失败：${(e && e.message) || e}`, "err");
    toast("导入失败", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "确认导入"; }
  }
}

// ============================================================
// 渲染
// ============================================================
/** 重绘当前视图（数据管理改动后调用） */
function render() {
  renderView(currentView);
}

/**
 * ★★ 市场版 1.1：机器人数据总览。
 *
 * 数据来自后端 `/data` 的 `botStats` 字段（main.py 的 `_bot_stats()`），
 * 这里只负责画成卡片。
 */
function buildBotStatsHtml() {
  const st = BOT_STATS;
  if (!st) {
    return `<div class="muted">正在读取统计…（如果一直这样，点「↻ 刷新数据」）</div>`;
  }
  const card = (icon, label, value, sub) =>
    `<div class="botstat">
       <div class="bs-icon">${icon}</div>
       <div class="bs-body">
         <div class="bs-val">${esc(String(value))}</div>
         <div class="bs-lbl">${esc(label)}</div>
         ${sub ? `<div class="bs-sub">${esc(sub)}</div>` : ""}
       </div>
     </div>`;

  let html = `<div class="muted" style="margin-bottom:12px">
    统计从**插件启动**开始累计；「收到消息」= 进入插件处理的消息条数，
    「发送消息」= 插件回复的条数。快照时间：<code>${esc(st.now || "—")}</code>
  </div>`;

  html += `<div class="botstat-grid">`;
  html += card("📥", "收到消息", st.recv || 0, "进入插件的消息");
  html += card("📤", "发送消息", st.send || 0, "插件发出的回复");
  html += card("👥", "见过消息的群", st.seen_count || 0, "有群员发过言");
  html += card("✅", "启用功能的群", st.enabled_count || 0,
               (st.enabled_groups || []).slice(0, 3).join("、") || "白名单为空=全部");
  html += card("🧩", "功能开关", `${st.feature_on || 0} / ${st.feature_total || 0}`,
               "已开启 / 总数");
  html += card("🗂️", "数据集合", st.collections || 0, "可在「数据管理」改");
  html += card("📋", "菜单数量", st.menus || 0, "含下级菜单");
  html += card("⚙️", "配置项", st.schema_keys || 0, "后台可调项");
  html += card("🔌", "Web 路由", st.routes || 0, "后台接口");
  html += card("⏱️", "运行时长", st.uptime_text || "—", "自插件启动");
  html += card("🏷️", "插件版本", st.version || "—", "");
  html += `</div>`;

  // 逐功能「开了几个群」
  const gf = st.group_feature_on || {};
  const gk = Object.keys(gf);
  if (gk.length) {
    html += `<div class="section-header" style="margin-top:18px">
      <div class="section-title">按群开启情况（只列有开启的）</div></div>`;
    html += `<div class="muted small" style="line-height:2">`;
    gk.sort((a, b) => gf[b] - gf[a]).forEach((k) => {
      html += `<span class="badge">${esc(k)}：${gf[k]} 个群</span> `;
    });
    html += `</div>`;
  }

  // 功能总开关
  const ft = st.features || {};
  const fk = Object.keys(ft);
  if (fk.length) {
    html += `<div class="section-header" style="margin-top:18px">
      <div class="section-title">全局功能开关</div></div>`;
    html += `<div class="muted small" style="line-height:2">`;
    fk.sort().forEach((k) => {
      html += `<span class="badge${ft[k] ? " on" : ""}">${
        ft[k] ? "✅" : "⬜"} ${esc(k)}</span> `;
    });
    html += `</div>`;
  }
  return html;
}

function renderView(viewKey) {
  const view = VIEWS[viewKey];
  if (!view) return;
  $("pageTitle").textContent = view.title;
  $("topbarActions").innerHTML = `<button class="btn btn-info" id="exportOpenBtn">💾 导出数据</button><button class="btn btn-info" id="importOpenBtn">📥 导入数据</button><button class="btn btn-primary" id="saveAllBtn">💾 保存全部</button>`;

  let html = "";
  // ★★ 市场版 1.1：说明（hint）**全部挪到页面最下面**，合并进**一个框**。
  //   以前 hint 散在各配置项中间，想改设置得在几十条说明里上下穿行。
  let hintHtml = "";
  let hintCount = 0;
  for (const group of view.groups) {
    // ---- 说明：只收集正文，稍后统一渲染 ----
    if (group.type === "hint") {
      hintHtml += renderHintPanel(group);
      hintCount += 1;
      continue;
    }

    html += `<div class="section">`;
    html += `<div class="section-header"><div class="section-title">${esc(group.title)}</div></div>`;

    if (group.type === "botstats") {
      html += buildBotStatsHtml();
    } else if (group.type === "menu-preview") {
      html += `<div class="menu-preview">${esc(menuPreviewText())}</div>`;
    } else if (group.type === "status-panel") {
      html += buildStatusPanelHtml();
    } else if (group.type === "data-manager") {
      html += renderDataManager();
    } else if (group.type === "data-selector") {
      html += renderSelector(group.keys || []);
    } else if (group.type === "birdstatus") {
      html += buildBirdStatusHtml();
    } else if (group.type === "mountstatus") {
      html += buildMountStatusHtml();
    } else if (group.type === "bankfreeze") {
      html += buildBankFrozenHtml();
    } else if (group.type === "paragraph") {
      html += renderParagraph(group.text || "");
    } else if (group.type === "open-page") {
      // ★★ 1.7.8：打开「专属设置页」的按钮（独立 HTML，不在主面板里堆表单）
      html += renderOpenPage(group);
    } else if (group.type === "goto-page") {
      // ★★ 1.7.8：**跳到另一个面板视图**（不弹窗，和点左侧导航一样）
      html += renderGotoPage(group);
    } else if (group.type === "ro-status") {
      // ★★ 1.7.8：只读展示「当前生效的规则」（真正的表单在专属页里）
      html += renderRoStatus(group);
    } else {
      for (const key of group.keys) {
        const s = SCHEMA[key];
        if (!s) {
          console.warn(`[render] SCHEMA 缺少字段: ${key}`);
          continue;
        }
        const type = s.type || "string";
        if (type === "bool") html += renderBool(key);
        else if (type === "int") html += renderInt(key);
        else if (type === "text") html += renderString(key, { textarea: true });
        else if (type === "template_list") html += renderTemplateList(key);
        else if (key === "output_bg_image") html += renderBgPicker(key);
        else if (Array.isArray(s.options) && s.options.length) html += renderEnum(key);
        else html += renderString(key);
      }
    }
    html += `</div>`;
  }

  // ---- 把收集到的说明合并成**一个框**，放在最下面 ----
  if (hintCount) {
    html += `<div class="section hint-section" id="hintSection">`
          + `<div class="section-header"><div class="section-title">`
          + `📖 说明（${hintCount} 条）　`
          + `<button class="btn btn-sm" id="hintToggleBtn" `
          + `data-open="1">收起</button></div></div>`
          + `<div id="hintBody">${hintHtml}</div></div>`;
  }

  $("content").innerHTML = html;
  bindBgPicker();
  // ★★ 市场版 1.1：说明区「收起 / 展开」（默认展开）
  const hintBtn = $("hintToggleBtn");
  if (hintBtn) {
    hintBtn.addEventListener("click", () => {
      const body = $("hintBody");
      if (!body) return;
      const open = hintBtn.dataset.open === "1";
      body.style.display = open ? "none" : "";
      hintBtn.dataset.open = open ? "0" : "1";
      hintBtn.textContent = open ? "展开" : "收起";
    });
  }
  const saveBtn = $("saveAllBtn");
  if (saveBtn) saveBtn.addEventListener("click", onSaveAll);
  const exportBtn = $("exportOpenBtn");
  if (exportBtn) exportBtn.addEventListener("click", openExportModal);
  const importBtn = $("importOpenBtn");
  if (importBtn) importBtn.addEventListener("click", openImportModal);

  const refreshBtn = $("refreshStatusBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", fetchStatusPreview);
  const testBtn = $("testPushBtn");
  if (testBtn) testBtn.addEventListener("click", onTestPush);

  // ★★ 1.7.8：「打开专属设置页」按钮
  document.querySelectorAll("[data-open-page]").forEach(el => {
    el.addEventListener("click", () => {
      const url = el.getAttribute("data-open-page");
      if (!url) return;
      try {
        const w = window.open(url, "_blank");
        if (!w) toast("被浏览器拦下弹窗了，请允许后重试", "error");
      } catch (e) {
        console.warn("[open-page] 打开失败", e);
        toast("打开失败：" + (e && e.message ? e.message : e), "error");
      }
    });
  });

  // ★★ 1.7.8：「跳到另一个视图」按钮 —— 等价于点左侧导航那一项
  document.querySelectorAll("[data-goto-view]").forEach(el => {
    el.addEventListener("click", () => {
      const v = el.getAttribute("data-goto-view");
      if (!v) return;
      const nav = document.querySelector(`.nav-item[data-view="${v}"]`);
      if (nav) { nav.click(); return; }
      toast("没找到目标页面：" + v, "error");
    });
  });

  attachTemplateEvents();
  attachDataEvents();
}

/**
 * ★★ 1.7.8：跳到另一个面板视图（等价于点左侧导航那一项，**不弹窗**）。
 */
function renderGotoPage(group) {
  const v = String(group.view || "");
  const cls = group.style === "primary" ? "btn btn-primary" : "btn btn-muted";
  return `<div class="open-page">
    <button class="${cls}" data-goto-view="${esc(v)}"
            type="button">${esc(group.label || "前往设置")}</button>
    ${group.desc ? `<div class="hint" style="margin-top:8px">${esc(group.desc)}</div>` : ""}
  </div>`;
}

/**
 * 只读展示「戳一戳」当前生效的规则。
 * 表单在专属设置页里，这里只是让人一眼看到现在是什么规则。
 */
function renderRoStatus() {
  const g = k => {
    const v = CONFIG[k];
    return (v === undefined || v === null || v === "") ? "（默认）" : String(v);
  };
  const on = CONFIG.poke_reply_enable === undefined
    ? true : !!CONFIG.poke_reply_enable;
  const self = CONFIG.poke_reply_only_self === undefined
    ? true : !!CONFIG.poke_reply_only_self;
  const bl = String(CONFIG.poke_reply_groups || "").trim();
  let wc = "-";
  try {
    const rows = (DATA_COLLECTIONS && DATA_COLLECTIONS["poke_reply_list"]) || [];
    wc = rows.length + " 条";
  } catch (e) { /* 忽略 */ }
  const rows = [
    ["总开关", on ? "✅ 已启用" : "⛔ 已停用"],
    ["限频窗口", g("poke_reply_window_sec") + " 秒"],
    ["窗口内最多回复", g("poke_reply_max_per_window") + " 次（所有群一起算）"],
    ["触发范围", self ? "只在戳机器人自己时回复" : "任何人戳任何人都回"],
    ["群号黑名单", bl ? bl : "（留空 = 所有群都生效）"],
    ["回复词库", wc],
  ];
  return `<div class="ro-status">` + rows.map(([k, v]) =>
    `<div class="ro-row"><span class="ro-k">${esc(k)}</span>`
    + `<span class="ro-v">${esc(v)}</span></div>`).join("") + `</div>`;
}

/**
 * ★★ 1.7.8：打开「专属设置页」的按钮。
 * group: { type:"open-page", title, path, label?, desc?, style? }
 *   path 形如 "poke" -> 打开 /<插件>/page/poke
 *   也可以直接给完整 url
 */
function renderOpenPage(group) {
  const p = String(group.path || "").replace(/^\/+/, "");
  const url = /^https?:/i.test(p)
    ? p
    : `/api/plug/${PLUGIN_ID}/page/${p}`;
  const label = group.label || "打开专属设置页";
  // ★ 注意：CSS 里是 .btn-primary（不是 .btn primary）
  const cls = group.style === "primary" ? "btn btn-primary" : "btn btn-muted";
  return `<div class="open-page">
    <button class="${cls}" data-open-page="${esc(url)}"
            type="button">${esc(label)}</button>
    ${group.desc ? `<div class="hint" style="margin-top:8px">${esc(group.desc)}</div>` : ""}
  </div>`;
}

/**
 * 统一提示面板。
 * group: { type:"hint", title?, tone?: "info"|"tip"|"warn", text }
 * text 里的 \n 会拆成多行；`反引号` 包住的片段会渲染成代码样式。
 */
function renderHintPanel(group) {
  const tone = group.tone === "tip" ? "tip"
    : group.tone === "warn" ? "warn" : "info";
  const icon = group.tone === "tip" ? "💡"
    : group.tone === "warn" ? "⚠️" : "ℹ️";
  const lines = String(group.text || "").split("\n");
  const body = lines.map((l) => {
    // `xxx` -> 代码样式（先转义再替换，避免注入）
    let s = esc(l).replace(/`([^`]+)`/g,
      '<span class="hint-code">$1</span>');
    // **xxx** -> 加粗
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (!s.trim()) return '<div class="hint-line">&nbsp;</div>';
    return `<div class="hint-line">${s}</div>`;
  }).join("");
  const title = group.title
    ? `<div class="hint-title">${esc(group.title)}</div>` : "";
  // ★★ 市场版 1.1：说明全部合并到一个框，这里只输出**内容**
  //   （不再自己画边框，否则会「框里套框」）
  return `<div class="hint-item tone-${tone}">`
    + `<div class="hint-icon">${icon}</div>`
    + `<div class="hint-body">${title}${body}</div>`
    + `</div>`;
}

function menuPreviewText() {
  return `━━━ 主菜单 ━━━
🎭 接口系统    ⛏ MC系统
📅 打卡系统    💰 签到系统
🎲 每日系列    🔧 管理系统
━━━━━━━━━━━━`;
}

// ============================================================
// 收集表单数据
// ============================================================
function collectFormData() {
  const data = {};

  document.querySelectorAll("[data-cfg]").forEach(el => {
    const key = el.dataset.cfg;
    const type = el.dataset.type;
    if (type === "bool") data[key] = el.checked;
    else if (type === "int") data[key] = parseInt(el.value) || 0;
    else data[key] = el.value;
  });

  document.querySelectorAll(".template-list").forEach(listEl => {
    const key = listEl.dataset.tplkey;
    const arr = [];
    listEl.querySelectorAll(".template-item").forEach(itemEl => {
      const obj = { __template_key: Object.keys((SCHEMA[key] || {}).templates || {})[0] || "" };
      itemEl.querySelectorAll("[data-field]").forEach(f => {
        obj[f.dataset.field] = f.value;
      });
      arr.push(obj);
    });
    data[key] = arr;
  });

  return data;
}

// ============================================================
// 保存全部
// ============================================================
/**
 * 把界面上所有数据编辑器里「与内存不一致」的集合逐个写盘。
 * 返回 { saved: [集合名], failed: [集合名] }。
 *
 * 说明：图片/视频/文本接口共享 api_list，三个编辑器可能是同一个集合，
 * 所以按集合名去重，只用第一个匹配的编辑器取值（saveRowsFor 会合并）。
 */
async function syncAllData() {
  const eds = document.querySelectorAll("#content .section[data-coll-view]");
  // ★ 这一页本来就没有数据编辑器（例如「抽奖功能」页只有配置表单）
  //   ——返回 hadEditors=false，让保存结果不要说「未找到编辑器」吓人。
  if (!eds.length) return { saved: [], failed: [], diag: [], hadEditors: false };

  // 集合名 -> 第一个编辑器
  const map = new Map();
  eds.forEach(ed => {
    const coll = editorCollection(ed);
    if (coll && !map.has(coll)) map.set(coll, ed);
  });

  const saved = [];
  const failed = [];
  const diag = [];
  const skipped = [];      // 内容没变的集合，兜底时强制写一遍
  for (const [coll, ed] of map) {
    let rows;
    try {
      rows = saveRowsFor(ed);
    } catch (e) {
      console.error(`[data] 收集 ${coll} 失败:`, e);
      diag.push(`${coll}:collect-error`);
      failed.push(coll);
      continue;
    }
    const oldRows = DATA_COLLECTIONS[coll] || [];
    // ★ 判断「有没有改动」要小心：内存副本可能被别处就地改过
    //   （例如删除处理器里的 splice），此时 oldRows 已经和界面上一致，
    //   直接比 JSON 会误判成「无改动」而跳过写入。
    //   所以：条数不同 -> 一定有改动；条数相同才逐字比较。
    const oldJson = JSON.stringify(oldRows);
    const newJson = JSON.stringify(rows);
    const changed = (oldRows.length !== rows.length) || (oldJson !== newJson);
    if (!changed) {
      console.log(`[data] ${coll} 无改动，跳过（${rows.length} 条）`);
      diag.push(`${coll}:unchanged`);
      skipped.push([coll, ed, rows]);
      continue;
    }
    if (oldJson === newJson && oldRows !== rows) {
      // 内容一样但条数也一样：仍算无改动，但记一下对象不同，
      // 便于排查「基准被就地修改」这类问题
      console.debug(`[data] ${coll} 内容相同但对象不同，视为无改动`);
    }
    console.log(`[data] 保存全部 -> ${coll}，${oldRows.length} -> ${rows.length} 条`);
    diag.push(`${coll}:${oldRows.length}->${rows.length}`);
    const ok = await saveCollection(coll, rows);
    if (ok) {
      DATA_COLLECTIONS[coll] = rows;
      saved.push(coll);
    } else {
      failed.push(coll);
    }
  }

  // ★ 兜底：如果**一个集合都没写进去**，就有可能是「界面变了但内存副本
  //   恰好相同」（例如删除又加回、或内存被别处改过）—— 这时强制把
  //   界面上看到的内容写一遍。内容确实没变的话，这次写入也是无害的，
  //   但能彻底消除「显示保存成功、其实什么都没写」的情况。
  if (!saved.length && !failed.length && skipped.length) {
    console.warn(`[data] 无集合被写入，启用强制写入兜底：`
      + skipped.map(s => s[0]).join(","));
    diag.push("force-write");
    for (const [coll, , rows] of skipped) {
      const ok = await saveCollection(coll, rows);
      if (ok) {
        DATA_COLLECTIONS[coll] = rows;
        saved.push(coll);
      } else {
        failed.push(coll);
      }
    }
  }
  // ★ 汇总一行，方便定位（原来只有 console.log，页面上一片安静）
  console.log(`[data] syncAllData 诊断: 编辑器 ${eds.length} 个，`
    + `集合 ${map.size} 个 [${diag.join(", ") || "无"}]，`
    + `saved=[${saved.join(",")}] failed=[${failed.join(",")}]`);
  return { saved, failed, diag, hadEditors: true };
}

/**
 * ★★ 1.7.6：检查「指令名重复」。
 *
 * 为什么需要：插件的指令匹配是**按顺序**跑的，两条功能用了同一个
 * 指令名时，只有先跑的那条会生效，另一条**静默失效** —— 用户很难发现。
 * （真实案例：银行用 `存钱`，签到商店的保险箱一开始也想用 `存钱`。）
 *
 * 只检查「指令类」字段（键名以 `_names` 结尾或以 `cmd_` 开头），
 * 值是逗号分隔的多个指令，逐个拆开比对。
 *
 * 返回 [{cmd, keys:[...]}] —— 同一个指令出现在多个字段里才算冲突。
 */
function findCommandConflicts() {
  const isCmdKey = (k) => /_names$/.test(k) || /^cmd_/.test(k);
  const map = {};      // 指令 -> [字段key]
  document.querySelectorAll("[data-cfg]").forEach(el => {
    const key = el.dataset.cfg;
    if (!key || !isCmdKey(key)) return;
    const type = el.dataset.type;
    if (type === "bool" || type === "int") return;
    const raw = String(el.value || "");
    raw.split(/[,，]/).forEach(one => {
      const cmd = one.trim();
      if (!cmd) return;
      if (!map[cmd]) map[cmd] = [];
      if (!map[cmd].includes(key)) map[cmd].push(key);
    });
  });
  const out = [];
  Object.keys(map).forEach(cmd => {
    if (map[cmd].length > 1) out.push({ cmd: cmd, keys: map[cmd] });
  });
  out.sort((a, b) => a.cmd.localeCompare(b.cmd));
  return out;
}

/** 把冲突列表拼成一句人话（最多列 6 条，其余省略） */
function describeCommandConflicts(list) {
  const show = list.slice(0, 6).map(c => `「${c.cmd}」→ ${c.keys.join(" / ")}`);
  const more = list.length > 6 ? ` …（共 ${list.length} 条）` : "";
  return show.join("；") + more;
}

async function onSaveAll() {
  const btn = $("saveAllBtn");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    // ① 先落盘所有改动的数据组（数据文件）
    let dataRes = { saved: [], failed: [] };
    try {
      dataRes = await syncAllData();
    } catch (e) {
      console.error("[save] 数据保存异常:", e);
      dataRes = { saved: [], failed: ["（异常）"] };
    }

    // ② 再保存配置表单
    const data = collectFormData();
    console.log("[save] 待提交配置:", data);
    // ★★ 1.7.6：保存前先检查「指令名重复」——
    //   同名指令只有先跑的那个生效，必须提醒用户。
    const conflicts = findCommandConflicts();
    if (conflicts.length) {
      console.warn("[save] 指令冲突:", conflicts);
      const detail = describeCommandConflicts(conflicts);
      const go = window.confirm(
        "⚠️ 检测到重复指令（同名指令只有先跑的那个生效）：\n\n"
        + detail.replace(/；/g, "\n")
        + "\n\n仍然保存吗？（建议先去把其中一个改掉）");
      if (!go) {
        toast("已取消保存，请先修改重复的指令名", "error");
        return;
      }
    }
    const cfgOk = await saveConfig(data);

    // ③ 汇总结果
    //   ★ 只有真的写了数据才说「已写入数据」；否则明确说「数据无改动」，
    //     避免「显示保存成功但其实什么也没写」这种误导。
    DATA_DIRTY = false;
    if (dataRes.failed.length) {
      toast(`❌ 数据保存失败：${dataRes.failed.join("、")}`
        + (cfgOk ? "（配置已保存）" : "（配置也失败）"), "error");
    } else if (!cfgOk) {
      toast("❌ 配置保存失败，请查看控制台", "error");
    } else if (dataRes.saved.length) {
      toast(`✅ 已保存配置，并写入数据：${dataRes.saved.join("、")}`);
    } else if (dataRes.hadEditors === false) {
      // ★ 这一页压根没有数据列表（纯配置页）-> 配置存好就是成功
      console.log("[save] 本页无数据编辑器，只有配置表单，配置已保存");
      toast("✅ 配置已保存，重启 AstrBot 生效");
    } else {
      const diag = (dataRes.diag || []).join(", ");
      console.warn(`[save] 没有数据集合被写入。诊断: [${diag || "编辑器未找到"}]`
        + `  编辑器数=${document.querySelectorAll(
             "#content .section[data-coll-view]").length}`);
      toast(`⚠️ 配置已保存，但**数据无改动**（${diag || "未找到数据编辑器"}）`
        + `　若你刚删过条目，请按 F12 看控制台的 [data] 诊断行`, "error");
    }
    // ★★ 1.7.6：保存完成后再提醒一次（上面用户可能选了「仍然保存」）
    checkCommandConflicts();
    render();
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 保存全部";
  }
}

/**
 * ★★ 1.7.6：保存前/后检查指令冲突。
 *
 * 冲突不阻断保存（用户可能只是想先存下来），但会**明确提示**，
 * 并把详情打到控制台，方便排查哪个字段撞了。
 */
function checkCommandConflicts() {
  let list = [];
  try {
    list = findCommandConflicts();
  } catch (e) {
    console.error("[conflict] 冲突检测异常:", e);
    return [];
  }
  if (!list.length) return [];
  const detail = describeCommandConflicts(list);
  console.warn("[conflict] 发现重复指令:", list);
  toast("⚠️ 检测到重复指令：" + detail
    + "　（同名指令只有先跑的那个生效，请改掉其中一个）", "error");
  return list;
}

// ============================================================
// template_list 增删事件
// ============================================================
function attachTemplateEvents() {
  document.querySelectorAll("[data-action='add-tpl']").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const data = collectFormData();
      if (!Array.isArray(data[key])) data[key] = [];
      const tplKey = Object.keys((SCHEMA[key] || {}).templates || {})[0] || "";
      const newItem = { __template_key: tplKey };
      const fields = Object.keys(((SCHEMA[key] || {}).templates || {})[tplKey]?.items || {});
      fields.forEach(f => newItem[f] = "");
      data[key].push(newItem);
      CONFIG[key] = data[key];
      renderView(currentView);
    });
  });

  document.querySelectorAll("[data-action='del-tpl']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const idx = parseInt(btn.dataset.idx);
      const _go = await uiConfirm(`确定删除该条目 #${idx + 1}？`,
                                  { okText: "删除" });
      if (!_go) return;
      const data = collectFormData();
      if (Array.isArray(data[key])) {
        data[key].splice(idx, 1);
        CONFIG[key] = data[key];
        renderView(currentView);
      }
    });
  });
}

// ============================================================
// 导航
// ============================================================
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", async () => {
    // 切走前先记住当前视图选中了哪个数据列表
    rememberDataSelection(currentView);
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    item.classList.add("active");
    currentView = item.dataset.view;
    if (!dataCollectionKeys().length) {
      try { await loadCollections(); } catch (e) { console.warn(e); }
    }
    // 回到这个视图时恢复上次选中的列表
    recallDataSelection(currentView);
    // ★ 1.7.6：切到坐骑页时重拉一次图片识别（新加的图不用手动点）
    if (currentView === "mount" && typeof loadMountStatus === "function") {
      try { await loadMountStatus(); } catch (e) { console.warn(e); }
    }
    // ★ 切到宠物/小鸟页同理
    if ((currentView === "bird" || currentView === "menu")
        && typeof loadBirdStatus === "function") {
      try { await loadBirdStatus(); } catch (e) { console.warn(e); }
    }
    renderView(currentView);
  });
});

// ============================================================
// 主题切换
// ============================================================
const themeBtn = $("themeToggleBtn");
if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const html = document.documentElement;
    html.setAttribute("data-theme", (html.getAttribute("data-theme") || "light") === "dark" ? "light" : "dark");
  });
}

// ============================================================
// 重新加载
// ============================================================
const reloadBtn = $("reloadBtn");
if (reloadBtn) {
  reloadBtn.addEventListener("click", () => location.reload());
}

// ============================================================
// 模态框（备用）
// ============================================================
const closeModal = $("closeEditModal");
if (closeModal) closeModal.addEventListener("click", () => $("editModal").classList.remove("open"));
const cancelModal = $("cancelEditBtn");
if (cancelModal) cancelModal.addEventListener("click", () => $("editModal").classList.remove("open"));

// ============================================================
// 启动流程（★ 桥接失败不阻塞，继续走 fetch）
// ============================================================
async function boot() {
  $("content").innerHTML = '<div class="loading">加载中...</div>';
  $("errorOverlay").classList.remove("show");

  console.log("=".repeat(60));
  console.log("[boot] 自定义娱乐配置页启动");
  console.log("[boot] window.AstrBotPluginPage:", bridge);
  console.log("=".repeat(60));

  const okBridge = await initBridge();
  // ★ 桥接失败也继续往下走，让 fetch 兜底
  const okLoad = await loadAllConfig();

  if (!okLoad) {
    $("errorOverlay").classList.add("show");
    $("errorBridgeStatus").textContent = okBridge ? "已就绪" : "不可用";
    const errEl = $("errorMsg");
    if (errEl && !errEl.textContent.trim()) {
      errEl.textContent = "无法读取插件配置，请检查后端路由是否注册成功，或查看浏览器控制台日志。";
    }
    return;
  }

  $("errorOverlay").classList.remove("show");

  // ★ 预加载数据集合（数据管理视图用；失败不阻塞页面）
  try {
    await loadCollections();
  } catch (e) {
    console.warn("[boot] 预加载数据集合失败:", e);
  }

  // ★ 预加载小鸟素材文件列表（小鸟图鉴选图用；失败不阻塞）
  try {
    CURRENT_DIR_HINT = (CONFIG && CONFIG.bird_image_dir) || "";
    // ★ 图片按昵称自动识别，只需拉一次识别结果（不再需要列目录）
    if (typeof loadBirdStatus === "function") await loadBirdStatus();
  } catch (e) {
    console.warn("[boot] 预加载小鸟素材失败:", e);
  }

  // ★ 1.7.6：预加载坐骑图片识别（失败不阻塞）
  try {
    if (typeof loadMountStatus === "function") await loadMountStatus();
  } catch (e) {
    console.warn("[boot] 预加载坐骑素材失败:", e);
  }

  renderView(currentView);
}

const retryBtn = $("retryBtn");
if (retryBtn) retryBtn.addEventListener("click", () => boot());

// 导出弹窗事件
const _exClose = $("closeExportModal");
if (_exClose) _exClose.addEventListener("click", closeExportModal);
const _exClose2 = $("closeExportBtn");
if (_exClose2) _exClose2.addEventListener("click", closeExportModal);
const _bkDo = $("doBackupBtn");
if (_bkDo) _bkDo.addEventListener("click", onDoBackup);
const _bkDl = $("doDownloadBtn");
if (_bkDl) _bkDl.addEventListener("click", onDownloadBackup);
const _exOverlay = $("exportModal");
if (_exOverlay) {
  _exOverlay.addEventListener("click", (e) => {
    if (e.target === _exOverlay) closeExportModal();
  });
}

// 导入弹窗事件
const _imClose = $("closeImportModal");
if (_imClose) _imClose.addEventListener("click", closeImportModal);
const _imClose2 = $("closeImportBtn");
if (_imClose2) _imClose2.addEventListener("click", closeImportModal);
const _bkImpPrev = $("doImportPreviewBtn");
if (_bkImpPrev) _bkImpPrev.addEventListener("click", onImportPreview);
const _bkImp = $("doImportBtn");
if (_bkImp) _bkImp.addEventListener("click", onDoImport);
const _imOverlay = $("importModal");
if (_imOverlay) {
  _imOverlay.addEventListener("click", (e) => {
    if (e.target === _imOverlay) closeImportModal();
  });
}

// 键盘快捷键 R：无输入焦点时强制刷新
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    location.reload();
  }
});

boot();