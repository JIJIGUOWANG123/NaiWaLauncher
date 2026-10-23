// 光影/资源包内容管理自检（0.1.6）：
// 依赖 kind 映射 / 落盘目录 / 光影内置前置 / 已装判定 / removeContentFile 跨类型拒绝。
// 全程离线：夹具 zip 由本脚本生成，下载走 127.0.0.1 上的临时 HTTP 服务；光影内置规则用桩替换 Modrinth 提供方。
// 末尾「联网」段落实打真实 Modrinth，只报告不计 FAIL。
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");

const ROOT = path.resolve(__dirname, "..");
const { initPaths, getPaths, instanceDir } = require("../dist-electron/main/core/paths.js");
initPaths(ROOT);
const { getSettings } = require("../dist-electron/main/core/settings.js");
const dependencies = require("../dist-electron/main/mods/dependencies.js");
const install = require("../dist-electron/main/mods/install.js");
const installed = require("../dist-electron/main/mods/installed.js");
const modrinth = require("../dist-electron/main/mods/modrinth.js");

// ---------- 断言与输出 ----------
let fails = 0;
const ok = (cond, label, extra) => {
  console.log("[" + (cond ? "PASS" : "FAIL") + "] " + label + (extra === undefined ? "" : " — " + extra));
  if (!cond) fails += 1;
  return cond;
};
const net = (cond, label, extra) =>
  console.log("[联网" + (cond ? "PASS" : "（不计 FAIL）") + "] " + label + (extra === undefined ? "" : " — " + extra));
const s = (...parts) => parts.map((part) => String(part)).join("");
const listing = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const printListing = (title, dir) => {
  const files = listing(dir);
  console.log(s("  ", title, "（", files.length, "）：", dir));
  for (const file of files) console.log(s("    ", file));
};
const isolation = getSettings().versionIsolation;
const expectedDir = (instanceId, sub) =>
  isolation === "none" ? path.join(getPaths().gameRoot, sub) : path.join(instanceDir(instanceId), sub);
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

// ---------- 夹具 ----------
const INST = "packcheck-fabric";
const inst = (id, mcVersion, loader) => ({
  id,
  name: id,
  mcVersion,
  loader,
  loaderVersion: "",
  versionId: mcVersion + "-" + loader,
  memoryMb: 2048,
  extraJvmArgs: "",
  createdAt: Date.now(),
});
const fabric = inst(INST, "1.21.4", "fabric");
const vanilla = inst("packcheck-vanilla", "1.21.4", "vanilla");
const lite = inst("packcheck-lite", "1.21.4", "liteloader");
const oldFabric = inst("packcheck-old", "1.7.10", "fabric");
const forge = inst("packcheck-forge", "1.20.1", "forge");

/** 本脚本创建的夹具实例 id：收尾只删这些名字本身，绝不按通配动别的实例。 */
const createdInstances = [];
let server = null;

/** 夹具实例写成真实例文件，联网段落里的 mods/index 会走 getInstance。 */
function ensureInstance(meta) {
  fs.mkdirSync(getPaths().instances, { recursive: true });
  const file = path.join(getPaths().instances, meta.id + ".json");
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
  if (!createdInstances.includes(meta.id)) createdInstances.push(meta.id);
  return file;
}

function readIndex() {
  const file = path.join(getPaths().meta, "mod-install-map.json");
  try {
    return { file: file, map: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { file: file, map: {} };
  }
}

/**
 * 收尾：删掉本脚本建的夹具实例（json + 同名目录）与安装索引里属于它们的键，
 * 并关闭本地下载源。正常结束与断言异常都要走到这里，重复运行才不会在实例目录里堆垃圾。
 */
async function cleanup() {
  const paths = getPaths();
  const removed = [];
  const kept = [];
  for (const id of createdInstances) {
    // 双保险：只处理夹具命名，且逐个核对路径最后一段就是这个名字
    if (!id.startsWith("packcheck-")) {
      kept.push(id + "（非夹具名，未处理）");
      continue;
    }
    const metaFile = path.join(paths.instances, id + ".json");
    if (path.basename(metaFile) === id + ".json" && fs.existsSync(metaFile)) {
      fs.rmSync(metaFile, { force: true });
      removed.push(metaFile);
    }
    const dir = path.join(paths.instances, id);
    if (path.basename(dir) === id && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir + "（目录）");
    }
  }

  const read = readIndex();
  if (fs.existsSync(read.file)) {
    let changed = false;
    for (const id of createdInstances) {
      if (Object.prototype.hasOwnProperty.call(read.map, id)) {
        delete read.map[id];
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(read.file, JSON.stringify(read.map, null, 2) + "\n", "utf8");
      removed.push(read.file + "（删掉夹具的键，其它 instanceId 原样保留）");
    }
  }

  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
    console.log("  已关闭本地下载源");
  }

  console.log("\n===== 收尾 =====");
  if (removed.length === 0) console.log("  没有需要清理的夹具残留");
  for (const item of removed) console.log("  已删除 " + item);
  for (const item of kept) console.log("  保留 " + item);
  console.log("  .minecraft/instances 剩余：" + (listing(paths.instances).join(", ") || "（空）"));
  const after = readIndex();
  console.log("  install-map.json 顶层剩余 instanceId：" + (Object.keys(after.map).join(", ") || "（空）"));
}

const modZip = new AdmZip();
modZip.addFile(
  "fabric.mod.json",
  Buffer.from(JSON.stringify({ schemaVersion: 1, id: "fakedep", name: "Fake Dep", version: "1.0.0" }), "utf8"),
);
const modBytes = modZip.toBuffer();

const packZip = new AdmZip();
packZip.addFile(
  "pack.mcmeta",
  Buffer.from(JSON.stringify({ pack: { pack_format: 15, description: { text: "Fake Resource Pack" } } }), "utf8"),
);
packZip.addFile("assets/fake/readme.txt", Buffer.from("fixture", "utf8"));
const packBytes = packZip.toBuffer();

const routes = new Map([
  ["/fake-mod.jar", modBytes],
  ["/fake-pack.zip", packBytes],
]);

function fileInfo(fileId, fileName, downloadUrl, gameVersions, loaders) {
  return {
    provider: "modrinth",
    fileId: fileId,
    name: fileName + " 1.0.0",
    fileName: fileName,
    downloadUrl: downloadUrl,
    gameVersions: gameVersions,
    loaders: loaders,
    exactMatch: false,
    releaseType: "release",
    downloads: 0,
    publishedAt: "2025-01-01T00:00:00Z",
  };
}

/** 假提供方：只有脚本显式配置的东西，绝不联网。 */
function makeProvider(config) {
  return {
    id: "modrinth",
    label: "FakeProvider",
    async search() {
      return [];
    },
    async listFiles(req) {
      const files = (config.files && config.files[req.projectId]) || [];
      return files.filter(
        (file) =>
          (!req.gameVersion || file.gameVersions.includes(req.gameVersion)) &&
          (!req.loader || file.loaders.includes(req.loader)),
      );
    },
    async getFile(projectId, fileId) {
      const hit =
        (config.resolved && (config.resolved[projectId + ":" + fileId] || config.resolved[fileId])) || null;
      if (!hit) throw new Error("假提供方没有配置 " + projectId + "/" + fileId);
      return hit;
    },
    async getDependencies(projectId) {
      return (config.deps && config.deps[projectId]) || [];
    },
    async getProject(projectId) {
      return config.projects && config.projects[projectId];
    },
    async getProjectType(projectId) {
      const kind = config.types && config.types[projectId];
      if (kind instanceof Error) throw kind;
      return kind;
    },
    normalize() {
      throw new Error("假提供方不支持 normalize");
    },
  };
}

const resolvedFor = (projectId, title, slug, fileName, url, sha, gameVersion, loaders) => ({
  info: fileInfo(fileName, fileName, url, [gameVersion], loaders),
  projectId: projectId,
  sha1: sha,
  project: { title: title, slug: slug },
});

(async () => {
  console.log("启动器根目录：" + ROOT);
  console.log("版本隔离：" + isolation + "（none → <gameRoot>/…，其它 → instances/<id>/…）");
  for (const meta of [fabric, vanilla, lite, oldFabric, forge]) console.log("夹具实例：" + ensureInstance(meta));

  // 本地下载源（离线，模拟 CDN）
  server = http.createServer((req, res) => {
    const body = routes.get(String(req.url || "").split("?")[0]);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": String(body.length), "content-type": "application/octet-stream" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  console.log("本地下载源：" + base + "（夹具 mod.jar " + modBytes.length + "B / pack.zip " + packBytes.length + "B）");

  const modSha = sha1(modBytes);
  const packSha = sha1(packBytes);

  console.log("\n===== 1) 依赖行的内容类型（getProjectType → kind） =====");
  const provider1 = makeProvider({
    types: { "fresh-animations": "resourcepack", entitytexturefeatures: "mod", "untyped-dep": undefined },
    deps: {
      "fresh-animations": [{ projectId: "entitytexturefeatures" }, { projectId: "untyped-dep" }],
      "bsl-shaders": [{ projectId: "entitytexturefeatures" }],
    },
    projects: {
      entitytexturefeatures: { title: "Entity Texture Features", slug: "entitytexturefeatures" },
      "untyped-dep": { title: "没有项目类型", slug: "untyped-dep" },
    },
  });
  const rpRows = await dependencies.getModDependencies(provider1, "fresh-animations", fabric, "fresh-1", "resourcepack");
  console.log("  getModDependencies(fresh-animations, kind=resourcepack) → " + rpRows.length + " 行");
  for (const row of rpRows) {
    console.log(
      "    - " + (row.name || row.projectId) + " | kind=" + row.kind + " | origin=" + row.origin + " | installed=" + row.installed,
    );
  }
  ok(rpRows.length === 2, "资源包项目解析出 2 条来源依赖");
  const etf = rpRows.find((row) => row.projectId === "entitytexturefeatures");
  ok(etf && etf.kind === "mod", 'getProjectType 返回 mod 的依赖行 kind === "mod"', etf && etf.kind);
  const untyped = rpRows.find((row) => row.projectId === "untyped-dep");
  ok(untyped && untyped.kind === "mod", "取不到项目类型时按 mod 兜底", untyped && untyped.kind);
  ok(rpRows.every((row) => row.origin === "source"), '来源依赖行 origin === "source"');
  const shaderWithDeps = await dependencies.getModDependencies(provider1, "bsl-shaders", fabric, "bsl-1", "shader");
  ok(
    shaderWithDeps.length === 1 && shaderWithDeps.every((row) => row.origin === "source"),
    "光影已声明依赖时不再叠加内置行",
    JSON.stringify(shaderWithDeps.map((row) => row.origin)),
  );

  console.log("\n===== 2) 落盘目录：资源包依赖 → resourcepacks/，模组依赖 → mods/ =====");
  const rpDep = {
    provider: "modrinth",
    projectId: "rpdep",
    name: "Fake RP",
    slug: "rpdep",
    required: true,
    installed: false,
    kind: "resourcepack",
  };
  const modDep = {
    provider: "modrinth",
    projectId: "moddep",
    name: "Fake Mod",
    slug: "moddep",
    required: true,
    installed: false,
    kind: "mod",
  };
  const provider2 = makeProvider({
    files: {
      rpdep: [fileInfo("fake-pack.zip", "fake-pack.zip", base + "/fake-pack.zip", ["1.21.4"], ["minecraft"])],
      moddep: [fileInfo("fake-mod.jar", "fake-mod.jar", base + "/fake-mod.jar", ["1.21.4"], ["fabric"])],
    },
    resolved: {
      "rpdep:fake-pack.zip": resolvedFor("rpdep", "Fake RP", "rpdep", "fake-pack.zip", base + "/fake-pack.zip", packSha, "1.21.4", ["minecraft"]),
      "moddep:fake-mod.jar": resolvedFor("moddep", "Fake Mod", "moddep", "fake-mod.jar", base + "/fake-mod.jar", modSha, "1.21.4", ["fabric"]),
    },
  });
  const rpResult = await dependencies.installDependency(provider2, fabric, rpDep);
  const modResult = await dependencies.installDependency(provider2, fabric, modDep);
  const rpDir = expectedDir(INST, "resourcepacks");
  const modsDir = expectedDir(INST, "mods");
  console.log("  installDependency(资源包) → " + rpResult.path);
  console.log("  installDependency(模组)   → " + modResult.path);
  ok(rpResult.path === path.join(rpDir, rpResult.fileName), "资源包依赖落在 <实例>/resourcepacks 下");
  ok(/\.zip$/i.test(rpResult.fileName), "资源包文件后缀是 .zip", rpResult.fileName);
  ok(path.dirname(modResult.path) === modsDir && /\.jar$/i.test(modResult.fileName), "模组依赖落在 <实例>/mods 下且是 .jar", modResult.path);

  const mapFile = path.join(getPaths().meta, "mod-install-map.json");
  const index = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  console.log("  安装索引 " + mapFile + " 中实例 " + INST + " 的记录：");
  for (const [fileName, record] of Object.entries(index[INST] || {})) {
    console.log("    - " + fileName + " → kind=" + record.kind + " provider=" + record.provider + " project=" + record.projectId);
  }
  ok(index[INST] && index[INST][rpResult.fileName] && index[INST][rpResult.fileName].kind === "resourcepack", '索引里资源包记录的 kind === "resourcepack"');
  ok(index[INST] && index[INST][modResult.fileName] && index[INST][modResult.fileName].kind === "mod", '索引里模组记录的 kind === "mod"');

  const scannedPacks = await installed.scanInstalledContent(INST, "resourcepack");
  const scannedPack = scannedPacks.find((item) => item.fileName === rpResult.fileName);
  ok(Boolean(scannedPack), "scanInstalledContent(resourcepack) 能看到这个 zip");
  ok(scannedPack && scannedPack.description === "Fake Resource Pack", "pack.mcmeta 的 description 被读出来", scannedPack && scannedPack.description);
  ok(scannedPack && scannedPack.name === rpResult.fileName.replace(/\.zip$/i, ""), "name 回退文件名", scannedPack && scannedPack.name);
  ok(scannedPack && typeof scannedPack.sha1 === "string" && scannedPack.sha1.length === 40, "sha1 复用 sha1OfFile");
  const scannedMods = await installed.scanInstalledContent(INST, "mod");
  ok(scannedMods.some((item) => item.fileName === modResult.fileName), "scanInstalledContent(mod) 仍走 mods 目录");

  console.log("\n===== 3) 光影内置前置（桩替换 Modrinth 提供方，离线） =====");
  const real = {
    listFiles: modrinth.modrinthProvider.listFiles,
    getFile: modrinth.modrinthProvider.getFile,
    getProject: modrinth.modrinthProvider.getProject,
    getProjectType: modrinth.modrinthProvider.getProjectType,
    search: modrinth.modrinthProvider.search,
  };
  const irisFile = fileInfo("iris-1.8.8.jar", "iris-1.8.8.jar", base + "/fake-mod.jar", ["1.21.4"], ["fabric"]);
  const oculusFile = fileInfo("oculus-1.7.0.jar", "oculus-1.7.0.jar", base + "/fake-mod.jar", ["1.20.1"], ["forge"]);
  let irisCalls = 0;
  modrinth.modrinthProvider.listFiles = async (req) => {
    irisCalls += 1;
    if (req.projectId === "iris") return req.gameVersion === "1.21.4" ? [irisFile] : [];
    // Oculus 真实只到 1.20.1：桩照抄这个约束
    if (req.projectId === "oculus") return req.gameVersion === "1.20.1" ? [oculusFile] : [];
    return [];
  };
  modrinth.modrinthProvider.getFile = async (projectId, fileId) => {
    const info = projectId === "oculus" ? Object.assign({}, oculusFile) : Object.assign({}, irisFile);
    info.fileId = fileId;
    return {
      info: info,
      projectId: projectId === "oculus" ? "OCULUSID" : "YL57xq9U",
      sha1: modSha,
      project: projectId === "oculus" ? { title: "Oculus", slug: "oculus" } : { title: "Iris Shaders", slug: "iris" },
    };
  };
  modrinth.modrinthProvider.getProject = async (projectId) =>
    projectId === "oculus" ? { title: "Oculus", slug: "oculus" } : { title: "Iris Shaders", slug: "iris" };
  modrinth.modrinthProvider.getProjectType = async () => "mod";

  const shaderProvider = makeProvider({ deps: {} }); // 光影来源零声明
  const shaderRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", fabric, "bsl-2", "shader");
  console.log("  fabric 实例 + 零声明光影 → " + shaderRows.length + " 行：");
  for (const row of shaderRows) {
    console.log(
      "    - " + (row.name || row.projectId) + " | origin=" + row.origin + " | kind=" + row.kind + " | required=" + row.required +
        " | installed=" + row.installed + " | projectId=" + row.projectId + " | versionId=" + row.versionId,
    );
  }
  const builtin = shaderRows.find((row) => row.origin === "builtin");
  ok(Boolean(builtin), 'fabric 实例出现 origin === "builtin" 的内置行');
  ok(builtin && builtin.kind === "mod" && builtin.required === true, '内置行 kind === "mod" 且 required === true', builtin && builtin.kind);
  ok(builtin && builtin.projectId === "YL57xq9U" && builtin.versionId === "iris-1.8.8.jar", "内置行带规范 projectId 与已选文件", builtin && builtin.projectId);
  ok(Boolean(builtin) && /Iris/i.test(builtin.name || ""), "内置行名称是 Iris", builtin && builtin.name);
  ok(Boolean(builtin) && builtin.installed === false, "内置行的 installed 走统一判定（此时未装）");

  irisCalls = 0;
  const vanillaRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", vanilla, "bsl-2", "shader");
  ok(vanillaRows.length === 0, "vanilla 实例不出现内置行");
  const liteRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", lite, "bsl-2", "shader");
  ok(liteRows.length === 0 && irisCalls === 0, "liteloader 实例不出现内置行，且没有发请求", irisCalls);
  const oldRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", oldFabric, "bsl-2", "shader");
  ok(oldRows.length === 0, "实例版本下 Iris 没有可用文件时不输出内置行（1.7.10 fabric）");

  const forgeRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", forge, "bsl-2", "shader");
  const oculusRow = forgeRows.find((row) => row.origin === "builtin");
  ok(Boolean(oculusRow) && oculusRow.slug === "oculus" && /Oculus/i.test(oculusRow.name || ""), "forge 1.20.1 的内置行是 Oculus", oculusRow && oculusRow.name);
  const forgeNew = inst("packcheck-forge-new", "1.21.4", "forge");
  ensureInstance(forgeNew);
  const forgeNewRows = await dependencies.getModDependencies(shaderProvider, "bsl-shaders", forgeNew, "bsl-2", "shader");
  ok(forgeNewRows.length === 0, "Oculus 只到 1.20.1：forge 1.21.4 不输出内置行");

  console.log("\n===== 4) installed 判定（索引 + 文件名两条路径） =====");
  const provider3 = makeProvider({
    types: { "rp-owner": "resourcepack", rpdep: "resourcepack", fileonlypack: "resourcepack" },
    deps: { "rp-owner": [{ projectId: "rpdep" }], "rp-owner-2": [{ projectId: "fileonlypack" }] },
    projects: { rpdep: { title: "Fake RP", slug: "rpdep" }, fileonlypack: { title: "File Only", slug: "fileonlypack" } },
  });
  const indexedRows = await dependencies.getModDependencies(provider3, "rp-owner", fabric, "rp-1", "resourcepack");
  console.log("  索引路径：" + JSON.stringify(indexedRows.map((row) => ({ kind: row.kind, installed: row.installed, file: row.installedFileName }))));
  ok(indexedRows[0] && indexedRows[0].kind === "resourcepack" && indexedRows[0].installed === true, ".zip 放进 resourcepacks 后该行 installed === true");
  ok(indexedRows[0] && indexedRows[0].installedFileName === rpResult.fileName, "installedFileName 指向资源包 zip", indexedRows[0] && indexedRows[0].installedFileName);

  // 只按文件名认（没有索引记录）：包名带版本号，靠 slug 前缀命中
  fs.writeFileSync(path.join(rpDir, "fileonlypack-v1.0.zip"), packBytes);
  const looseRows = await dependencies.getModDependencies(provider3, "rp-owner-2", fabric, "rp-2", "resourcepack");
  ok(
    looseRows[0] && looseRows[0].installed === true && looseRows[0].installedFileName === "fileonlypack-v1.0.zip",
    "无索引记录时按文件名 slug 命中（fileonlypack-v1.0.zip）",
    looseRows[0] && looseRows[0].installedFileName,
  );

  console.log("\n===== 5) listInstalledContent（索引 + 磁盘扫描兜底，只读） =====");
  const refs = await dependencies.listInstalledContent(INST);
  console.log("  listInstalledContent(" + INST + ") → " + refs.length + " 条");
  for (const ref of refs) {
    console.log(
      "    - source=" + ref.source + " | kind=" + ref.kind + " | fileName=" + ref.fileName + " | " + ref.provider + "/" + ref.projectId +
        " | modId=" + ref.modId + " | name=" + ref.name,
    );
  }
  console.log("  原始返回：" + JSON.stringify(refs));
  const refMod = refs.find((ref) => ref.kind === "mod");
  const refRp = refs.find((ref) => ref.kind === "resourcepack" && ref.fileName === rpResult.fileName);
  const refLoose = refs.find((ref) => ref.fileName === "fileonlypack-v1.0.zip");
  // 此刻磁盘：mods/ 1 个索引 jar；resourcepacks/ 1 个索引 zip + 1 个无索引散包（第 4 段写的）
  ok(refs.length === 3, "2 条索引 + 1 条扫描散包 = 3 条", refs.length);
  ok(
    Boolean(refMod) && refMod.source === "index" && refMod.fileName === modResult.fileName && refMod.projectId === "moddep" && refMod.provider === "modrinth",
    "模组索引条目 source/fileName/projectId 正确",
    refMod && refMod.source + " / " + refMod.fileName + " / " + refMod.projectId,
  );
  ok(
    Boolean(refMod) && refMod.modId === "fakedep" && refMod.name === "Fake Dep",
    "模组索引条目顺带补上 jar 元数据 modId/name",
    refMod && refMod.modId + " / " + refMod.name,
  );
  ok(
    Boolean(refRp) && refRp.source === "index" && refRp.projectId === "rpdep",
    "资源包索引条目 source/projectId 正确",
    refRp && refRp.source + " / " + refRp.projectId,
  );
  ok(
    Boolean(refLoose) && refLoose.source === "scan" && refLoose.projectId === "" && refLoose.versionId === undefined,
    "无索引的散包以 source=scan 出现，projectId 为空串",
    refLoose && refLoose.source + " / projectId=「" + refLoose.projectId + "」",
  );
  ok(refs[0] && refs[0].kind === "mod" && refs[1] && refs[1].kind === "resourcepack", "顺序按 kind 再按 fileName（mod 在 resourcepack 前）", refs.map((ref) => ref.kind).join(","));

  // 索引保留、文件手删：不能再算已装
  fs.rmSync(path.join(rpDir, rpResult.fileName), { force: true });
  const afterDelete = await dependencies.listInstalledContent(INST);
  console.log("  删掉资源包文件（索引保留）后 → " + JSON.stringify(afterDelete.map((ref) => ref.kind + ":" + ref.fileName)));
  ok(!afterDelete.some((ref) => ref.fileName === rpResult.fileName), "磁盘上已删除的资源包索引条目不再返回");
  ok(afterDelete.some((ref) => ref.fileName === "fileonlypack-v1.0.zip" && ref.source === "scan"), "仍在磁盘的散包扫描条目照旧返回");
  ok(afterDelete.some((ref) => ref.kind === "mod" && ref.fileName === modResult.fileName), "模组条目仍在");
  ok(
    Boolean(index[INST] && index[INST][rpResult.fileName]),
    "索引里那条记录确实还在（只是磁盘核对没通过）",
  );

  const emptyInstance = inst("packcheck-empty", "1.21.4", "fabric");
  ensureInstance(emptyInstance);
  const emptyRefs = await dependencies.listInstalledContent("packcheck-empty");
  ok(Array.isArray(emptyRefs) && emptyRefs.length === 0, "空实例（无任何记录）返回 []", JSON.stringify(emptyRefs));
  const missingRefs = await dependencies.listInstalledContent("packcheck-missing");
  ok(Array.isArray(missingRefs) && missingRefs.length === 0, "索引里没有的实例返回 [] 且不抛错");

  // kind 决定目录：resourcepack 记录只有 mods/ 下的同名文件时不能算已装
  const shadowName = "shadow-pack.zip";
  const modsShadow = path.join(modsDir, shadowName);
  fs.writeFileSync(modsShadow, packBytes);
  const mapWithShadow = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  mapWithShadow[INST][shadowName] = { provider: "modrinth", projectId: "shadowpack", versionId: "shadow-1", kind: "resourcepack" };
  fs.writeFileSync(mapFile, JSON.stringify(mapWithShadow, null, 2) + "\n", "utf8");
  const shadowRefs = await dependencies.listInstalledContent(INST);
  console.log("  同名文件只在 mods/ 时 → " + JSON.stringify(shadowRefs.map((ref) => ref.kind + ":" + ref.fileName)));
  ok(!shadowRefs.some((ref) => ref.fileName === shadowName), "resourcepack 记录不因 mods/ 有同名文件被误判为已装");
  mapWithShadow[INST][shadowName].kind = "mod";
  fs.writeFileSync(mapFile, JSON.stringify(mapWithShadow, null, 2) + "\n", "utf8");
  const asModRefs = await dependencies.listInstalledContent(INST);
  ok(asModRefs.some((ref) => ref.kind === "mod" && ref.fileName === shadowName), "同一条记录改成 mod 后（文件就在 mods/）才算已装");
  delete mapWithShadow[INST][shadowName];
  fs.writeFileSync(mapFile, JSON.stringify(mapWithShadow, null, 2) + "\n", "utf8");
  fs.rmSync(modsShadow, { force: true });
  console.log("  已还原安装索引与 mods/ 下的临时文件");

  // 5e) 手工丢进 mods/ 的 jar（不写索引）：扫描兜底要认出来
  const handName = "hand-placed-1.0.jar";
  const handZip = new AdmZip();
  handZip.addFile(
    "fabric.mod.json",
    Buffer.from(JSON.stringify({ schemaVersion: 1, id: "handplaced", name: "Hand Placed", version: "2.0.0" }), "utf8"),
  );
  fs.writeFileSync(path.join(modsDir, handName), handZip.toBuffer());
  const handRefs = await dependencies.listInstalledContent(INST);
  const handScan = handRefs.find((ref) => ref.fileName === handName);
  console.log("  手工放入 " + handName + "（无索引）→ " + JSON.stringify(handScan));
  ok(Boolean(handScan) && handScan.source === "scan", "手工放入的 jar 以 source=scan 出现", handScan && handScan.source);
  ok(
    Boolean(handScan) && handScan.modId === "handplaced" && handScan.name === "Hand Placed" && handScan.projectId === "",
    "扫描条目带 jar 元数据的 modId/name，projectId 为空串",
    handScan && handScan.modId + " / " + handScan.name + " / projectId=「" + handScan.projectId + "」",
  );

  // 5f) 同一文件写进索引 → 变成 source=index，且不出现两条同名条目
  const mapWithHand = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  mapWithHand[INST][handName] = { provider: "modrinth", projectId: "handplaced-proj", versionId: "hand-v1", kind: "mod" };
  fs.writeFileSync(mapFile, JSON.stringify(mapWithHand, null, 2) + "\n", "utf8");
  const indexedHandRefs = await dependencies.listInstalledContent(INST);
  const handIndexed = indexedHandRefs.filter((ref) => ref.fileName === handName);
  console.log("  写进索引后 → " + JSON.stringify(handIndexed));
  ok(handIndexed.length === 1, "同一文件名只出现一条（索引优先，不重复）", handIndexed.length);
  ok(
    handIndexed[0] && handIndexed[0].source === "index" && handIndexed[0].projectId === "handplaced-proj",
    "写进索引后 source 由 scan 变 index",
    handIndexed[0] && handIndexed[0].source + " / " + handIndexed[0].projectId,
  );
  ok(handIndexed[0] && handIndexed[0].modId === "handplaced", "索引条目仍带 modId（复用扫描结果，不重复解析 jar）", handIndexed[0] && handIndexed[0].modId);

  // 5g) 资源包扫描条目 name = 文件名主干
  const packScan = indexedHandRefs.find((ref) => ref.fileName === "fileonlypack-v1.0.zip");
  ok(
    Boolean(packScan) && packScan.source === "scan" && packScan.name === "fileonlypack-v1.0",
    "资源包扫描条目 name 是文件名主干",
    packScan && packScan.name,
  );

  // 5h) 索引 + 扫描混排：数量、去重与顺序都稳定
  const mixedKeys = indexedHandRefs.map((ref) => ref.kind + "|" + ref.fileName);
  const nonDecreasing = indexedHandRefs.every(
    (ref, i) => i === 0 || mixedKeys[i - 1].localeCompare(mixedKeys[i]) <= 0,
  );
  console.log("  混排结果：" + JSON.stringify(mixedKeys));
  ok(indexedHandRefs.length === 3, "索引 2 条 + 扫描 1 条 = 3 条", indexedHandRefs.length);
  ok(new Set(mixedKeys).size === mixedKeys.length, "同一条记录只出现一次（kind+fileName 唯一）", mixedKeys.length);
  ok(nonDecreasing, "排序稳定：按 kind 再按 fileName 非递减", mixedKeys.join(","));
  ok(
    indexedHandRefs.filter((ref) => ref.source === "index").length === 2 &&
      indexedHandRefs.filter((ref) => ref.source === "scan").length === 1,
    "source 计数：index 2 / scan 1",
    indexedHandRefs.map((ref) => ref.source).join(","),
  );

  // 还原：手写的索引记录与手工放入的 jar 都清掉，后面的删除段只面对原来的两个文件
  delete mapWithHand[INST][handName];
  fs.writeFileSync(mapFile, JSON.stringify(mapWithHand, null, 2) + "\n", "utf8");
  fs.rmSync(path.join(modsDir, handName), { force: true });
  console.log("  已还原安装索引与手工放入的 jar");

  console.log("\n===== 6) removeContentFile 跨类型拒绝 =====");
  const badRp = await throws(() => install.removeContentFile(INST, "some-mod.jar", "resourcepack"));
  ok(Boolean(badRp) && /\.zip/.test(badRp.message), "resourcepack kind 传 .jar 必须抛错", badRp && badRp.message);
  const badMod = await throws(() => install.removeContentFile(INST, "some-pack.zip", "mod"));
  ok(Boolean(badMod) && /\.jar/.test(badMod.message), "mod kind 传 .zip 必须抛错", badMod && badMod.message);
  const badModpack = await throws(() => install.removeContentFile(INST, "pack.mrpack", "modpack"));
  ok(Boolean(badModpack), "modpack kind 直接拒绝（没有可管理的内容目录）", badModpack && badModpack.message);

  // 上一段验证「磁盘删除 → 不再返回」时删掉了这个文件，这里还原成可删除的状态
  fs.writeFileSync(path.join(rpDir, rpResult.fileName), packBytes);
  fs.writeFileSync(path.join(rpDir, rpResult.fileName) + ".bak", packBytes);
  const removed = await throws(() => install.removeContentFile(INST, rpResult.fileName, "resourcepack"));
  ok(removed === null, "resourcepack 的 .zip 可以删除", removed && removed.message);
  ok(
    !fs.existsSync(path.join(rpDir, rpResult.fileName)) && !fs.existsSync(path.join(rpDir, rpResult.fileName) + ".bak"),
    "同名 .bak 一并删除",
  );
  const stillMod = await throws(() => install.removeContentFile(INST, modResult.fileName, "mod"));
  ok(stillMod === null, "mod kind 仍删得掉自己的 .jar", stillMod && stillMod.message);

  console.log("\n--- 相关目录 listing ---");
  printListing("实例 resourcepacks", rpDir);
  printListing("实例 mods", modsDir);
  printListing("实例 shaderpacks", expectedDir(INST, "shaderpacks"));
  console.log("  contentDirForInstance 口径：" + install.contentDirForInstance(fabric, "resourcepack"));

  // 还原真提供方，后面段落要联网
  Object.assign(modrinth.modrinthProvider, real);

  console.log("\n===== 联网）真实 Modrinth 项目类型与依赖（失败不计 FAIL） =====");
  const mods = require("../dist-electron/main/mods/index.js");
  const netTypes = { "fresh-animations": "resourcepack", "bsl-shaders": "shader", sodium: "mod" };
  for (const [projectId, expected] of Object.entries(netTypes)) {
    try {
      const kind = await modrinth.modrinthProvider.getProjectType(projectId);
      net(kind === expected, "Modrinth project_type(" + projectId + ") === " + expected, kind);
    } catch (err) {
      net(false, "Modrinth project_type(" + projectId + ") 查询失败", err.message);
    }
  }
  try {
    const rows = await mods.getModDependencies("modrinth", "bsl-shaders", INST, undefined, "shader");
    const row = rows.find((item) => item.origin === "builtin");
    net(Boolean(row), "真实光影 bsl-shaders → 内置 Iris 行", row ? row.name + " (" + row.projectId + ", " + row.versionId + ")" : JSON.stringify(rows));
    net(Boolean(row) && row.kind === "mod", '真实内置行 kind === "mod"', row && row.kind);
  } catch (err) {
    net(false, "真实光影依赖解析失败", err.message);
  }
  // 资源包的最新版本并不总是声明依赖：挑一个确实声明了必需依赖的真实版本，验证 kind 映射
  try {
    const files = await modrinth.modrinthProvider.listFiles({ provider: "modrinth", projectId: "fresh-animations", gameVersion: "1.21.4", loader: undefined });
    let picked = null;
    for (const file of files) {
      const raw = await modrinth.modrinthProvider.getDependencies("fresh-animations", file.fileId);
      if (raw.length > 0) {
        picked = file;
        console.log("  真实资源包里声明依赖的版本：" + file.fileId + "（" + raw.length + " 个必需依赖）");
        break;
      }
    }
    if (!picked) {
      net(false, "本次没有找到声明依赖的真实资源包版本（网络数据变化，非代码问题）");
    } else {
      const rows = await mods.getModDependencies("modrinth", "fresh-animations", INST, picked.fileId, "resourcepack");
      net(rows.length > 0, "真实资源包版本能解析出必需依赖", rows.map((row) => (row.name || row.projectId) + ":" + row.kind).join(", "));
      net(rows.every((row) => row.kind === "mod"), '真实资源包的依赖行 kind === "mod"', JSON.stringify(rows.map((row) => row.kind)));
    }
  } catch (err) {
    net(false, "真实资源包依赖解析失败", err.message);
  }

  console.log("\n===== 结果 =====");
  console.log(fails === 0 ? "全部离线断言 PASS" : "有 " + fails + " 条离线断言 FAIL");
  process.exitCode = fails === 0 ? 0 : 1;
})().then(
  () => cleanup(),
  (err) => {
    console.error("[FAIL] 自检异常：", err && err.stack ? err.stack : err);
    process.exitCode = 1;
    return cleanup();
  },
).catch((err) => {
  // 收尾本身失败也要让退出码说明问题，不能让脚本静默留下垃圾
  console.error("[FAIL] 收尾异常：", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
