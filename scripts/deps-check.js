// 前置依赖自检（真实网络 + 真实实例目录）：
// 依赖解析 / installed 两条判定路径（安装索引 + jar 扫描）/ installDependencies 连装 / 幂等 / 无 Key 的 CurseForge。
// 链路上真实可用的依赖关系：Iris 的必需前置是 Sodium（Modrinth，1.21.4 fabric）。
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const { initPaths, getPaths } = require("../dist-electron/main/core/paths.js");
initPaths(ROOT);

const mods = require("../dist-electron/main/mods/index.js");
const dependencies = require("../dist-electron/main/mods/dependencies.js");
const curseforge = require("../dist-electron/main/mods/curseforge.js");

const FIXTURE = "depcheck-fabric";
const EXISTING = "diaglaunch-ea9072";
const SODIUM = "AANobbMI";
const IRIS = "YL57xq9U";
const WAYSTONES = "waystones";

const ok = (cond, label) => console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
const row = (d) =>
  `  - ${d.name ?? "<无名称>"} | ${d.provider} ${d.projectId} | slug=${d.slug ?? "-"} | required=${d.required} | installed=${d.installed} | installedFileName=${d.installedFileName ?? "-"}`;
const listing = (instanceId) => {
  const dir = path.join(getPaths().instances, instanceId, "mods");
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const printListing = (title, files) => {
  console.log(`${title} (${files.length}):`);
  for (const f of files) console.log(`  ${f}`);
};
const diff = (before, after) => ({
  added: after.filter((f) => !before.includes(f)),
  removed: before.filter((f) => !after.includes(f)),
});
const indexFile = () => path.join(getPaths().meta, "mod-install-map.json");
const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), "utf8"));
  } catch {
    return {};
  }
};
const writeIndex = (value) => fs.writeFileSync(indexFile(), JSON.stringify(value, null, 2) + "\n", "utf8");

// 请求计数：core/http 全部走 global fetch，包一层即可统计真实网络行为
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  calls.push(url);
  return realFetch(input, init);
};
const resetCalls = () => {
  calls.length = 0;
};
const downloadCount = () => calls.filter((u) => /cdn\.modrinth\.com|mediafilez\.forgecdn\.net/.test(u)).length;
const apiCount = () => calls.filter((u) => /api\.modrinth\.com|api\.curseforge\.com|api\.cfwidget\.com/.test(u)).length;

function ensureFixture() {
  const file = path.join(getPaths().instances, `${FIXTURE}.json`);
  if (!fs.existsSync(file)) {
    const meta = {
      id: FIXTURE,
      name: "DepCheck Fabric",
      mcVersion: "1.21.4",
      loader: "fabric",
      loaderVersion: "0.16.9",
      versionId: "1.21.4-fabric",
      memoryMb: 2048,
      extraJvmArgs: "",
      createdAt: Date.now(),
    };
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
  }
  console.log(`自检夹具实例：${file}`);
}

/** 夹具实例从干净状态开始：清掉 mods 里的 jar 与本实例的索引记录，保证每次跑的前后对比可读。 */
function resetFixture() {
  const dir = path.join(getPaths().instances, FIXTURE, "mods");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (/\.jar$/i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  const map = readIndex();
  if (map[FIXTURE]) {
    delete map[FIXTURE];
    writeIndex(map);
  }
  console.log(`清空夹具实例模组目录与索引：${dir}`);
}

/**
 * 预览阶段先跟 CDN 建一次连接：本机首次连 cdn.modrinth.com 要 7s 左右，会踩到下载层的 6s 连接超时。
 * 自检只关心依赖逻辑，先把连接预热掉（失败忽略）。
 */
async function warmup(projectIds) {
  for (const projectId of projectIds) {
    try {
      const files = await mods.listModFiles({
        provider: "modrinth", projectId, gameVersion: "1.21.4", loader: "fabric",
      });
      const url = files[0] && files[0].downloadUrl;
      if (!url) continue;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
          const res = await fetch(url, {
            headers: { "user-agent": "NaiWaLauncher/0.1 (naiwa)", range: "bytes=0-1023" },
            signal: controller.signal,
          });
          await res.arrayBuffer();
          console.log(`预热 CDN 连接：${projectId} → HTTP ${res.status}`);
          break;
        } catch (err) {
          console.log(`预热失败（忽略）：${projectId} 第 ${attempt} 次 · ${err.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      console.log(`预热取文件失败（忽略）：${projectId} · ${err.message}`);
    }
  }
}

(async () => {
  ensureFixture();
  resetFixture();
  await warmup([SODIUM, IRIS]);

  console.log("\n===== 1) Modrinth 依赖解析（只读，实例 " + EXISTING + "，loader=vanilla）=====");
  const irisDeps = await mods.getModDependencies("modrinth", IRIS, EXISTING);
  console.log(`getModDependencies(modrinth, ${IRIS}=iris) → ${irisDeps.length} 条必需前置：`);
  irisDeps.forEach((d) => console.log(row(d)));
  ok(irisDeps.length > 0, "Iris 声明了必需前置");
  ok(irisDeps.every((d) => d.required), "返回项全部 required=true");
  ok(irisDeps.some((d) => d.slug === "sodium" && d.name), "依赖名称/slug 已补全（sodium）");
  ok(irisDeps.every((d) => d.installed === false), "空实例里 installed 全为 false");

  const sodiumDeps = await mods.getModDependencies("modrinth", SODIUM, EXISTING);
  console.log(`\ngetModDependencies(modrinth, ${SODIUM}=sodium) → ${sodiumDeps.length} 条：${JSON.stringify(sodiumDeps)}`);
  ok(sodiumDeps.length === 0, "Sodium 自身没有必需前置（返回空数组而不是报错）");

  console.log("\n===== 2) 先装前置 → 再查依赖（实例 " + FIXTURE + "，fabric 1.21.4）=====");
  const before2 = listing(FIXTURE);
  printListing("安装前 mods 目录", before2);
  resetCalls();
  const sodiumInstall = await mods.installMod({ provider: "modrinth", projectId: SODIUM, instanceId: FIXTURE });
  const after2 = listing(FIXTURE);
  console.log(`installMod(sodium) → ${sodiumInstall.fileName}（installedDependencies=${JSON.stringify(sodiumInstall.installedDependencies)}）· API ${apiCount()} 次 / 下载 ${downloadCount()} 次`);
  printListing("安装后 mods 目录", after2);
  const afterIrisDeps = await mods.getModDependencies("modrinth", IRIS, FIXTURE);
  console.log("再查 Iris 的依赖：");
  afterIrisDeps.forEach((d) => console.log(row(d)));
  const sodiumDep = afterIrisDeps.find((d) => d.slug === "sodium" || d.projectId === SODIUM);
  ok(Boolean(sodiumDep && sodiumDep.installed === true), "装上前置后 installed 变 true");
  ok(Boolean(sodiumDep && sodiumDep.installedFileName === sodiumInstall.fileName), `installedFileName = ${sodiumDep && sodiumDep.installedFileName}`);

  console.log("\n===== 3) installMod({installDependencies:true})：连装 + 幂等 =====");
  // 先删掉 jar（模拟用户手动删除）：索引里的旧记录必须靠磁盘核对判为「未装」
  await mods.remove(FIXTURE, sodiumInstall.fileName);
  const afterRemove = listing(FIXTURE);
  printListing("删除 sodium 后", afterRemove);
  const staleDeps = await mods.getModDependencies("modrinth", IRIS, FIXTURE);
  ok(staleDeps.every((d) => !d.installed), "jar 已删：索引残留不误判为已装");

  const beforeIris = listing(FIXTURE);
  printListing("装 Iris 前 mods 目录", beforeIris);
  resetCalls();
  const irisInstall = await mods.installMod({
    provider: "modrinth",
    projectId: IRIS,
    instanceId: FIXTURE,
    installDependencies: true,
  });
  const afterIris = listing(FIXTURE);
  const delta = diff(beforeIris, afterIris);
  console.log(`installMod(iris, installDependencies:true) → ${irisInstall.fileName}`);
  console.log(`  installedDependencies = ${JSON.stringify(irisInstall.installedDependencies)}`);
  console.log(`  新增 = ${JSON.stringify(delta.added)} · 移除 = ${JSON.stringify(delta.removed)} · API ${apiCount()} 次 / 下载 ${downloadCount()} 次`);
  printListing("装 Iris 后 mods 目录", afterIris);
  ok(irisInstall.installedDependencies.length === 1, "installedDependencies 里正好一个前置");
  ok(delta.added.length === 2, "本次新增两个 jar（前置 + 本体）");
  ok(!afterIris.some((f) => f.endsWith(".bak")), "没有产生 .bak");

  console.log("\n--- 再跑一次：全部跳过（幂等）---");
  resetCalls();
  const irisAgain = await mods.installMod({
    provider: "modrinth",
    projectId: IRIS,
    instanceId: FIXTURE,
    installDependencies: true,
  });
  const afterIris2 = listing(FIXTURE);
  console.log(
    `第二次 → ${irisAgain.fileName} · installedDependencies=${JSON.stringify(irisAgain.installedDependencies)} · 下载 ${downloadCount()} 次 · API ${apiCount()} 次 · 列表不变=${JSON.stringify(afterIris) === JSON.stringify(afterIris2)}`,
  );
  console.log(`  列表比对：${JSON.stringify(diff(afterIris, afterIris2))}`);
  ok(irisAgain.installedDependencies.length === 0, "已装前置全部跳过");
  ok(downloadCount() === 0, "没有重新下载（0 次下载请求）");
  ok(JSON.stringify(afterIris) === JSON.stringify(afterIris2), "mods 目录完全不变（无新文件、无 .bak）");

  console.log("\n===== 4) installed 的两条判定路径 =====");
  const map = readIndex();
  const entries = map[FIXTURE] ?? {};
  console.log(`安装索引 ${indexFile()} 中实例 ${FIXTURE} 的记录：`);
  for (const [fileName, record] of Object.entries(entries)) {
    console.log(`  - ${fileName} → ${JSON.stringify(record)}`);
  }
  ok(Object.keys(entries).length >= 2, "索引记录已写入（含前置与本体）");

  const sodiumJar = afterIris2.find((f) => /sodium/i.test(f));
  console.log(`\n--- 4b) 删掉索引里 ${sodiumJar} 的记录，只剩 jar 扫描路径 ---`);
  const trimmed = JSON.parse(JSON.stringify(map));
  delete trimmed[FIXTURE][sodiumJar];
  writeIndex(trimmed);
  const scanDeps = await mods.getModDependencies("modrinth", IRIS, FIXTURE);
  scanDeps.forEach((d) => console.log(row(d)));
  const scanSodium = scanDeps.find((d) => d.projectId === SODIUM);
  ok(Boolean(scanSodium && scanSodium.installed), "索引无记录时靠 jar 内 modId 扫描仍判为已装");
  ok(Boolean(scanSodium && scanSodium.installedFileName === sodiumJar), `扫描路径给出 installedFileName = ${scanSodium && scanSodium.installedFileName}`);
  writeIndex(map);

  console.log("\n===== 5) CurseForge 无 Key 路径 =====");
  const cfDeps = await mods.getModDependencies("curseforge", WAYSTONES, FIXTURE);
  console.log(`getModDependencies(curseforge, ${WAYSTONES}) → ${JSON.stringify(cfDeps)}`);
  const raw = await realFetch("https://api.cfwidget.com/minecraft/mc-mods/" + WAYSTONES);
  const body = await raw.json();
  const keys = Object.keys(body);
  console.log(`cfwidget 项目响应字段：${keys.join(",")}`);
  console.log(`cfwidget 文件条目字段：${Object.keys(body.files[0] ?? {}).join(",")}`);
  ok(!keys.includes("dependencies"), "cfwidget 不提供 dependencies 字段 → 无 Key 模式没有依赖数据可解析");
  ok(cfDeps.length === 0, "无 Key 路径返回空数组（不猜、不报错）");

  console.log("\n--- 5b) 官方接口形状的依赖解析（关系类型过滤 + 去重）---");
  const official = {
    data: {
      id: 238222,
      modId: 238222,
      dependencies: [
        { modId: 111111, relationType: 3 },
        { modId: 222222, relationType: 2 },
        { modId: 111111, relationType: 3 },
        { modId: 333333, relationType: 1 },
        { modId: 444444, relationType: 3 },
      ],
    },
  };
  const parsed = curseforge.requiredDependencies(official.data);
  console.log(`requiredDependencies(...) → ${JSON.stringify(parsed)}`);
  ok(parsed.length === 2 && parsed.every((d) => d.projectId !== "222222" && d.projectId !== "333333"), "只留 relationType=3 且按 modId 去重");

  console.log("\n===== 6) 前置安装失败 → 阻断本体（不留半成品）=====");
  for (const fileName of listing(FIXTURE)) await mods.remove(FIXTURE, fileName);
  printListing("清空后 mods 目录", listing(FIXTURE));
  const realInstallDependency = dependencies.installDependency;
  dependencies.installDependency = async () => {
    throw new Error("模拟下载中断");
  };
  let blocked = null;
  try {
    await mods.installMod({ provider: "modrinth", projectId: IRIS, instanceId: FIXTURE, installDependencies: true });
  } catch (err) {
    blocked = err;
  }
  dependencies.installDependency = realInstallDependency;
  console.log(`  抛出：${blocked && blocked.message}`);
  ok(Boolean(blocked && /前置 Sodium 安装失败/.test(blocked.message)), '错误文案是「前置 Sodium 安装失败：…」');
  ok(Boolean(blocked && /本体未安装/.test(blocked.message)), "错误里说明了当前状态");
  ok(listing(FIXTURE).length === 0, "本体确实没有装上（失败即阻断）");

  const retry = await mods.installMod({
    provider: "modrinth",
    projectId: IRIS,
    instanceId: FIXTURE,
    installDependencies: true,
  });
  console.log(`  恢复后重试 → ${retry.fileName} · installedDependencies=${JSON.stringify(retry.installedDependencies)}`);
  ok(retry.installedDependencies.length === 1 && listing(FIXTURE).length === 2, "重试把前置与本体都装上了");

  console.log("\n===== 结果 =====");
  console.log(`夹具实例 mods 目录（自检残留，可手工删除）：${path.join(getPaths().instances, FIXTURE, "mods")}`);
  printListing("最终 mods 目录", listing(FIXTURE));
})().catch((err) => {
  console.error("[FAIL] 自检异常：", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
