import { useEffect, useMemo, useState } from "react";
import type { ServerCoreId, ServerEntry } from "../../shared/types";
import { api } from "../lib/api";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Field, Select, Slider, TextInput, Toggle } from "./Form";

/** FastMirror 的 tag 是英文 id，界面上要换成中文说明。 */
const TAG_LABEL: Record<string, string> = { pure: "插件服", mod: "模组服", vanilla: "原版" };

const DEFAULT_PORT = "25565";
const DEFAULT_MEMORY = 2048;
const DEFAULT_MAX_PLAYERS = "20";

/**
 * 新建服务端：核心 → 游戏版本 → 构建 三级联动，默认值按 FastMirror 的推荐排序自动带出来。
 * 只负责收集参数并调用 servers.create，落盘与下载都在主进程。
 */
export function ServerCreateModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (entry: ServerEntry) => void;
}) {
  const { push } = useToast();
  const [core, setCore] = useState<ServerCoreId | "">("");
  const [mcVersion, setMcVersion] = useState("");
  const [coreVersion, setCoreVersion] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [memoryMb, setMemoryMb] = useState(DEFAULT_MEMORY);
  const [maxPlayers, setMaxPlayers] = useState(DEFAULT_MAX_PLAYERS);
  const [onlineMode, setOnlineMode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cores = useAsync(() => (open ? api.servers.cores() : Promise.resolve([])), [open]);
  const selectedCore = useMemo(
    () => (cores.data ?? []).find((item) => item.core === core) ?? null,
    [core, cores.data],
  );
  const builds = useAsync(
    () => (open && core && mcVersion ? api.servers.builds(core, mcVersion) : Promise.resolve([])),
    [open, core, mcVersion],
  );

  // 打开时把核心默认到推荐项（Paper / Fabric 之类），关掉后不清空，方便再次打开看到上次的选择。
  useEffect(() => {
    if (!open) return;
    const list = cores.data ?? [];
    if (list.length === 0) return;
    setCore((prev) => (prev && list.some((item) => item.core === prev) ? prev : (list.find((item) => item.recommend) ?? list[0]).core));
  }, [cores.data, open]);

  // 换核心后游戏版本回到该核心支持的最新一个。
  useEffect(() => {
    if (!open || !selectedCore) return;
    setMcVersion((prev) => (selectedCore.mcVersions.includes(prev) ? prev : selectedCore.mcVersions[0] ?? ""));
  }, [open, selectedCore]);

  // 换版本后构建回到最新一条。
  useEffect(() => {
    if (!open || !core || !mcVersion) return;
    const list = builds.data ?? [];
    setCoreVersion((prev) => (prev && list.some((item) => item.coreVersion === prev) ? prev : list[0]?.coreVersion ?? ""));
  }, [builds.data, core, mcVersion, open]);

  // 名称没被手动改过时，跟着核心 + 版本自动填一个。
  useEffect(() => {
    if (!open || nameTouched) return;
    if (!core || !mcVersion) return;
    setName(`${core} ${mcVersion}`);
  }, [core, mcVersion, nameTouched, open]);

  const coreOptions = useMemo(
    () => (cores.data ?? []).map((item) => ({
      value: item.core,
      label: `${item.core}（${TAG_LABEL[item.tag] ?? item.tag}）`,
      title: item.homepage,
    })),
    [cores.data],
  );
  const versionOptions = useMemo(
    () => (selectedCore?.mcVersions ?? []).map((version) => ({ value: version, label: version })),
    [selectedCore],
  );
  const buildOptions = useMemo(
    () => (builds.data ?? []).map((item) => ({
      value: item.coreVersion,
      label: `${item.coreVersion} · ${item.updateTime}`,
      title: item.sha1,
    })),
    [builds.data],
  );

  const submit = async () => {
    if (!core || !mcVersion || !coreVersion) {
      setError("先选好核心、游戏版本与构建");
      return;
    }
    const portNum = Number(port);
    const maxNum = Number(maxPlayers);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError("端口需要是 1-65535 的整数");
      return;
    }
    if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 1000) {
      setError("最大人数需要是 1-1000 的整数");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await api.servers.create({
        name: name.trim() || `${core} ${mcVersion}`,
        core,
        mcVersion,
        coreVersion,
        port: portNum,
        memoryMb,
        maxPlayers: maxNum,
        onlineMode,
      });
      push(`已创建服务端「${entry.meta.name}」`, "success");
      onCreated(entry);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建服务端"
      subtitle="服务端从 FastMirror 下载，数据放在启动器目录的 servers 下"
      width={560}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            data-action="server-create-submit"
            onClick={() => void submit()}
            disabled={busy || cores.loading || builds.loading || !coreVersion}
          >
            {busy ? "创建中…" : "创建并下载"}
          </button>
        </>
      )}
    >
      <div className="form-grid">
      <Field label="名称" hint="留空就用「核心 + 版本」当名字">
        <TextInput
          value={name}
          maxLength={40}
          placeholder="例如：朋友服 Paper"
          aria-label="服务端名称"
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
          }}
        />
      </Field>

      <Field label="核心" hint={cores.error ?? "FastMirror 提供原版 / 插件服 / 模组服三类核心"}>
        <Select
          value={core}
          options={coreOptions}
          onChange={(value) => setCore(value as ServerCoreId)}
          ariaLabel="服务端核心"
          placeholder={cores.loading ? "读取核心列表…" : "选择核心"}
          disabled={cores.loading || busy}
        />
      </Field>

      <Field label="游戏版本" hint="按核心支持列表倒序，最新的在最上面">
        <Select
          value={mcVersion}
          options={versionOptions}
          onChange={setMcVersion}
          ariaLabel="游戏版本"
          placeholder={core ? "选择游戏版本" : "先选核心"}
          disabled={!core || busy}
        />
      </Field>

      <Field label="构建" hint={builds.loading ? "读取构建列表…" : (builds.error ?? "构建越新，修掉的漏洞与兼容问题越多")}>
        <Select
          value={coreVersion}
          options={buildOptions}
          onChange={setCoreVersion}
          ariaLabel="服务端构建"
          placeholder={mcVersion ? "选择构建" : "先选游戏版本"}
          disabled={!mcVersion || builds.loading || busy}
        />
      </Field>

      <div className="server-form-row">
        <Field label="端口" hint="默认 25565，同机多开时各用一个">
          <TextInput
            type="number"
            min={1}
            max={65535}
            value={port}
            aria-label="端口"
            onChange={(event) => setPort(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="最大人数" hint="写进 server.properties 的 max-players">
          <TextInput
            type="number"
            min={1}
            max={1000}
            value={maxPlayers}
            aria-label="最大人数"
            onChange={(event) => setMaxPlayers(event.target.value)}
            disabled={busy}
          />
        </Field>
      </div>

      <Field label="内存" hint="写进启动参数 -Xmx；插件/模组越多要留得越多">
        <Slider
          value={memoryMb}
          min={512}
          max={16384}
          step={512}
          onChange={setMemoryMb}
          format={(value) => `${value} MB`}
          disabled={busy}
        />
      </Field>

      <Toggle
        checked={onlineMode}
        onChange={setOnlineMode}
        label="正版验证"
        hint="关掉后离线客户端也能进（online-mode=false）"
      />

      <p className="server-form-note">创建会下载服务端 jar，可能需要几十 MB；下载失败可以在列表里重试或删除重建。</p>
      {error ? <p className="server-form-error" data-server-create-error>{error}</p> : null}
      </div>
    </Modal>
  );
}
