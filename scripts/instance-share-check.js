// 自检：实例导出/导入（清单内容、跳过目录、重名、目录穿越防护、无效实例包）。
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const AdmZip = require("adm-zip");

const root = path.join(__dirname, "..");

// 主进程模块会 require("electron")：换成只提供 dialog 的桩，把保存/打开框的答案脚本化
const electronPath = require.resolve("electron");
const scripted = { savePath: null, saveCanceled: false, openQueue: [], openCanceled: false, saveOptions: null, openOptions: null };
const electronStub = {
  dialog: {
    showSaveDialog: async (options) => {
      scripted.saveOptions = options;
      return scripted.saveCanceled || !scripted.savePath
        ? { canceled: true, filePath: undefined }
        : { canceled: false, filePath: scripted.savePath };
    },
    showOpenDialog: async (options) => {
      scripted.openOptions = options;
      return scripted.openCanceled || scripted.openQueue.length === 0
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [scripted.openQueue.shift()] };
    },
  },
};
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: electronStub,
};

const dist = path.join(root, "dist-electron", "main");
const { initPaths, ensureDirs, getPaths, instanceDir } = require(path.join(dist, "core", "paths"));
const { loadSettings } = require(path.join(dist, "core", "settings"));
const {
  createInstanceRecord,
  deleteInstance,
  getInstance,
  listInstances,
} = require(path.join(dist, "minecraft", "instances"));
const { exportInstance, importInstance } = require(path.join(dist, "minecraft", "share"));

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + " | " + label + (detail ? " | " + detail : ""));
  if (!ok) failures += 1;
}

/** 目录清单（相对路径，正斜杠），可排除根目录下的若干目录。 */
function inventory(dir, skipTop = [], rel = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? rel + "/" + entry.name : entry.name;
    if (!rel && skipTop.includes(entry.name)) continue;
    if (entry.isDirectory()) out.push(...inventory(path.join(dir, entry.name), skipTop, childRel));
    else out.push(childRel);
  }
  return out.sort();
}

function diffLists(a, b) {
  const onlyA = a.filter((item) => !b.includes(item));
  const onlyB = b.filter((item) => !a.includes(item));
  return { onlyA, onlyB };
}

const tempDirsBefore = new Set(
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("naiwa-instance-")),
);

(async () => {
  initPaths(root);
  await ensureDirs();
  await loadSettings();

  const scratch = path.join(root, ".scratch", "share-selfcheck");
  fs.mkdirSync(scratch, { recursive: true });

  // ---------- 1) 真实导出 diaglaunch-ea9072 ----------
  const source = await getInstance("diaglaunch-ea9072");
  if (!source) throw new Error("找不到实例 diaglaunch-ea9072");
  const zipPath = path.join(scratch, "diaglaunch.zip");
  fs.rmSync(zipPath, { force: true });
  scripted.savePath = zipPath;
  const exported = await exportInstance("diaglaunch-ea9072");
  check("导出的 path 是落盘真实路径", exported.path === zipPath && fs.existsSync(zipPath), exported.path);
  check("导出的 sizeBytes 与磁盘一致", exported.sizeBytes === fs.statSync(zipPath).size, exported.sizeBytes + " 字节");
  check(
    "保存框默认文件名 <实例名>-<mcVersion>.zip",
    /DiagLaunch-1\.21\.4\.zip$/.test(String(scripted.saveOptions && scripted.saveOptions.defaultPath)),
    String(scripted.saveOptions && scripted.saveOptions.defaultPath),
  );

  const outZip = new AdmZip(zipPath);
  const outNames = outZip.getEntries().map((entry) => entry.entryName).sort();
  const manifest = JSON.parse(outZip.getEntry("naiwa-instance.json").getData().toString("utf8"));
  console.log("[zip] 路径 = " + zipPath);
  console.log("[zip] 条目数 = " + outNames.length + "（其中清单 1 个）");
  console.log("[zip] 条目 = " + outNames.join(" , "));
  console.log("[zip] 清单 = " + JSON.stringify(manifest));

  check("清单 formatVersion=1", manifest.formatVersion === 1);
  check("清单 name/mcVersion", manifest.name === source.name && manifest.mcVersion === source.mcVersion, manifest.name + " / " + manifest.mcVersion);
  check("清单 loader/loaderVersion", manifest.loader === source.loader && (manifest.loaderVersion ?? undefined) === source.loaderVersion, manifest.loader + (manifest.loaderVersion ? " " + manifest.loaderVersion : ""));
  check("清单 fileCount = 条目数-1", manifest.fileCount === outNames.length - 1, manifest.fileCount);
  check("清单用当前启动器版本", typeof manifest.launcherVersion === "string" && /^\d+\./.test(manifest.launcherVersion), manifest.launcherVersion);
  check("logs/ 未被打包", !outNames.some((name) => name === "logs" || name.startsWith("logs/")), "源 logs 文件数 = " + inventory(path.join(instanceDir(source.id), "logs")).length);
  check("crash-reports/ screenshots/ 未被打包", !outNames.some((name) => /^(crash-reports|screenshots)\//.test(name)));
  check("保留了 options.txt", outNames.includes("options.txt"));
  const sourceInventory = inventory(instanceDir(source.id), ["logs", "crash-reports", "screenshots"]);
  const { onlyA, onlyB } = diffLists(sourceInventory, outNames.filter((name) => name !== "naiwa-instance.json"));
  check("zip 条目 = 实例目录全部内容（跳过三目录）", onlyA.length === 0 && onlyB.length === 0, "缺 " + JSON.stringify(onlyA) + " 多 " + JSON.stringify(onlyB));

  // 取消导出
  scripted.saveCanceled = true;
  const canceled = await exportInstance("diaglaunch-ea9072");
  check("取消导出返回 { path: null, sizeBytes: 0 }", canceled.path === null && canceled.sizeBytes === 0 && canceled.name === source.name, JSON.stringify(canceled));
  scripted.saveCanceled = false;

  // ---------- 2) 导入该 zip ----------
  scripted.openQueue.push(zipPath);
  const imported = await importInstance();
  const created = imported.instanceId ? await getInstance(imported.instanceId) : null;
  check("导入返回 instanceId", typeof imported.instanceId === "string" && !!created, imported.instanceId);
  check(
    "打开框只认 .zip",
    Array.isArray(scripted.openOptions && scripted.openOptions.filters) &&
      scripted.openOptions.filters[0].extensions.includes("zip") &&
      scripted.openOptions.properties.includes("openFile"),
    JSON.stringify(scripted.openOptions && scripted.openOptions.filters),
  );
  check("重名自动加序号", new RegExp("^" + source.name + " \\(\\d+\\)$").test(imported.name), imported.name);
  check("mcVersion/loader 沿用清单", created.mcVersion === source.mcVersion && created.loader === source.loader, created.mcVersion + " / " + created.loader + (created.loaderVersion ? " " + created.loaderVersion : ""));
  check("versionId 指向已装目录", created.versionId === source.versionId, created.versionId);
  check("已装齐时不需要补装", imported.installedMissing === undefined, String(imported.installedMissing));

  const importedInventory = inventory(instanceDir(created.id));
  const diffImported = diffLists(sourceInventory, importedInventory);
  check("实例目录内容与原实例一致", diffImported.onlyA.length === 0 && diffImported.onlyB.length === 0, "缺 " + JSON.stringify(diffImported.onlyA) + " 多 " + JSON.stringify(diffImported.onlyB));
  const modsSource = inventory(path.join(instanceDir(source.id), "mods")).length;
  const modsImported = inventory(path.join(instanceDir(created.id), "mods")).length;
  check("mods 数量一致", modsSource === modsImported, modsSource + " vs " + modsImported);
  check("清单文件没有落进实例目录", !fs.existsSync(path.join(instanceDir(created.id), "naiwa-instance.json")));
  const leftoverTemp = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("naiwa-instance-") && !tempDirsBefore.has(name));
  check("导入临时目录已清理", leftoverTemp.length === 0, JSON.stringify(leftoverTemp));
  console.log("[import] id = " + created.id + " · name = " + created.name + " · " + created.mcVersion + " / " + created.loader);

  // ---------- 3) 带 "../evil.txt" 的恶意包 ----------
  const evilZipPath = path.join(scratch, "evil.zip");
  const evilZip = new AdmZip();
  evilZip.addFile(
    "naiwa-instance.json",
    Buffer.from(
      JSON.stringify({ formatVersion: 1, name: "EvilPack", mcVersion: "1.21.4", loader: "vanilla", createdAt: Date.now(), fileCount: 2, launcherVersion: "0.1.3" }),
    ),
  );
  evilZip.addFile("mods/ok.jar", Buffer.from("ok-mod"));
  // adm-zip 的 addFile 会规范化掉 ".."：先按合法名加进去，再把 entryName 改回穿越路径
  evilZip.addFile("evil.txt", Buffer.from("evil-should-never-land"));
  evilZip.getEntry("evil.txt").entryName = "../evil.txt";
  evilZip.addFile("absolute-evil.txt", Buffer.from("evil-should-never-land"));
  evilZip.getEntry("absolute-evil.txt").entryName = "/absolute-evil.txt";
  evilZip.writeZip(evilZipPath);
  console.log("[evil zip] 条目 = " + new AdmZip(evilZipPath).getEntries().map((entry) => entry.entryName).join(" , "));

  scripted.openQueue.push(evilZipPath);
  const evilResult = await importInstance();
  const evilInstance = evilResult.instanceId ? await getInstance(evilResult.instanceId) : null;
  check("恶意包仍能导入（越界条目只跳过）", !!evilInstance, evilResult.instanceId);
  check("恶意包的合法条目落盘", evilInstance ? fs.existsSync(path.join(instanceDir(evilInstance.id), "mods", "ok.jar")) : false);
  const evilLeftovers = [
    path.join(getPaths().instances, "evil.txt"),
    path.join(getPaths().instances, "absolute-evil.txt"),
    path.join(getPaths().gameRoot, "evil.txt"),
    path.join(getPaths().gameRoot, "absolute-evil.txt"),
    path.join(getPaths().root, "evil.txt"),
    path.join(instanceDir(evilInstance ? evilInstance.id : "x"), "..", "evil.txt"),
  ].filter((candidate) => fs.existsSync(candidate));
  check("实例目录外没有文件落下", evilLeftovers.length === 0, JSON.stringify(evilLeftovers));
  const evilContents = inventory(instanceDir(evilInstance ? evilInstance.id : "x"));
  check("恶意实例目录里没有 evil 文件", !evilContents.some((name) => name.includes("evil")), JSON.stringify(evilContents));

  // ---------- 4) 没有清单的 zip ----------
  const bareZipPath = path.join(scratch, "bare.zip");
  const bareZip = new AdmZip();
  bareZip.addFile("mods/some.jar", Buffer.from("x"));
  bareZip.writeZip(bareZipPath);
  scripted.openQueue.push(bareZipPath);
  let bareError = null;
  try {
    await importInstance();
  } catch (err) {
    bareError = err.message;
  }
  check("缺清单抛「不是有效的 NaiWa 实例包」", !!bareError && bareError.includes("不是有效的 NaiWa 实例包"), bareError);

  // 取消导入
  scripted.openCanceled = true;
  const openCanceled = await importInstance();
  check("取消导入返回 { instanceId: null, name: \"\" }", openCanceled.instanceId === null && openCanceled.name === "", JSON.stringify(openCanceled));
  scripted.openCanceled = false;

  // ---------- 5) 非空 mods 的往返（证明 mods 内容真的搬过去了） ----------
  const modInstance = await createInstanceRecord({
    name: "ShareCheckMods",
    mcVersion: "1.21.4",
    loader: "vanilla",
    versionId: "1.21.4",
  });
  fs.mkdirSync(path.join(instanceDir(modInstance.id), "mods"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(modInstance.id), "mods", "a.jar"), "aaa");
  fs.writeFileSync(path.join(instanceDir(modInstance.id), "mods", "b.jar"), "bbb");
  const modZipPath = path.join(scratch, "mods.zip");
  scripted.savePath = modZipPath;
  const modExported = await exportInstance(modInstance.id);
  scripted.openQueue.push(modZipPath);
  const modImported = await importInstance();
  const modImportedInstance = modImported.instanceId ? await getInstance(modImported.instanceId) : null;
  check("带 mods 的实例往返：mods 数量一致", modImportedInstance ? inventory(path.join(instanceDir(modImportedInstance.id), "mods")).length === 2 : false, modExported.sizeBytes + " 字节 · " + (modImportedInstance ? inventory(path.join(instanceDir(modImportedInstance.id), "mods")).join(",") : "无"));
  check("重名固定追加 \" (2)\"", modImported.name === "ShareCheckMods (2)", modImported.name);

  // ---------- 6) 缺原版/加载器时走补装分支（安装器与网络打桩，只验决策与入参） ----------
  const installMod = require(path.join(dist, "minecraft", "install"));
  const instancesMod = require(path.join(dist, "minecraft", "instances"));
  const realIsInstalled = installMod.isVersionInstalled;
  const realCreateInstance = instancesMod.createInstance;
  const installCalls = [];
  installMod.isVersionInstalled = async () => false;
  instancesMod.createInstance = async (req) => {
    installCalls.push(req);
    return createInstanceRecord({
      name: req.name,
      mcVersion: req.mcVersion,
      loader: req.loader,
      ...(req.loaderVersion ? { loaderVersion: req.loaderVersion } : {}),
      versionId: req.mcVersion,
    });
  };
  let missingResult = null;
  let missingInstance = null;
  try {
    const fabricZipPath = path.join(scratch, "fabric-pack.zip");
    const fabricZip = new AdmZip();
    fabricZip.addFile(
      "naiwa-instance.json",
      Buffer.from(
        JSON.stringify({ formatVersion: 1, name: "FabricPack", mcVersion: "1.21.4", loader: "fabric", loaderVersion: "0.16.9", createdAt: Date.now(), fileCount: 1, launcherVersion: "0.1.3" }),
      ),
    );
    fabricZip.addFile("options.txt", Buffer.from("lang:zh_cn"));
    fabricZip.writeZip(fabricZipPath);
    scripted.openQueue.push(fabricZipPath);
    missingResult = await importInstance();
    missingInstance = missingResult.instanceId ? await getInstance(missingResult.instanceId) : null;
  } finally {
    installMod.isVersionInstalled = realIsInstalled;
    instancesMod.createInstance = realCreateInstance;
  }
  check("缺加载器时 installedMissing = true", missingResult && missingResult.installedMissing === true, JSON.stringify(missingResult));
  check("补装走 createInstance 且 loader/loaderVersion 一并写入", installCalls.length === 1 && installCalls[0].loader === "fabric" && installCalls[0].loaderVersion === "0.16.9" && missingInstance && missingInstance.loader === "fabric" && missingInstance.loaderVersion === "0.16.9", JSON.stringify(installCalls[0]));
  if (missingInstance) await deleteInstance(missingInstance.id);

  // ---------- 清理：只留 diaglaunch 的导入实例作证据 ----------
  if (evilInstance) await deleteInstance(evilInstance.id);
  if (modInstance) await deleteInstance(modInstance.id);
  if (modImportedInstance) await deleteInstance(modImportedInstance.id);
  check("清理后实例列表", true, (await listInstances()).map((instance) => instance.name).join(" , "));

  const leftoverTempAfter = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("naiwa-instance-") && !tempDirsBefore.has(name));
  check("所有导入的临时目录都已清理", leftoverTempAfter.length === 0, JSON.stringify(leftoverTempAfter));

  console.log(failures === 0 ? "ALL PASS" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("自检崩了：" + (err && err.stack ? err.stack : err));
  process.exit(2);
});
