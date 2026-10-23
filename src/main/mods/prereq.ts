// 光影的内置前置规则：光影本身只是个包，真正把它加载起来的是光影模组（Iris / Oculus）。
// 来源站点对光影几乎不声明依赖（实测 bsl-shaders / complementary 全版本零声明），所以这里按实例加载器补一条。
// 两条铁律：来源已经声明了必需依赖就不再叠加；没在实例版本 + 加载器下查到可用文件就不输出——宁可不说，不能给出装不上的前置。
import type { InstanceMeta, LoaderKind, ModDependency } from "../../shared/types";
import { logger } from "../core/logger";
import { modrinthProvider } from "./modrinth";
import { bestFile, messageOf, type ModProvider } from "./provider";

const log = logger("mods");

/** 加载器 → 光影前置（Modrinth 项目 slug 与显示名）：vanilla/liteloader 没有光影模组生态，不给。 */
const SHADER_PREREQ: Partial<Record<LoaderKind, { slug: string; name: string }>> = {
  fabric: { slug: "iris", name: "Iris Shaders" },
  quilt: { slug: "iris", name: "Iris Shaders" },
  neoforge: { slug: "iris", name: "Iris Shaders" },
  forge: { slug: "oculus", name: "Oculus" },
};

/**
 * 光影在「实例 mcVersion + 加载器」下的内置前置；任何一步拿不到结果都返回 undefined。
 * 前置一律来自 Modrinth：它的 slug 稳定，且 Iris/Oculus 的版本列表就是判定「装得上」的唯一依据。
 */
export async function shaderBuiltinDependency(instance: InstanceMeta): Promise<ModDependency | undefined> {
  const rule = SHADER_PREREQ[instance.loader];
  if (!rule) return undefined;

  const provider: ModProvider = modrinthProvider;
  try {
    const files = await provider.listFiles({
      provider: provider.id,
      projectId: rule.slug,
      gameVersion: instance.mcVersion,
      loader: instance.loader,
    });
    const best = bestFile(files, instance.mcVersion, instance.loader);
    if (!best) {
      log.info(`${rule.name} 在 ${instance.mcVersion} / ${instance.loader} 下没有可用文件，不补光影前置`);
      return undefined;
    }

    // 反查规范项目 id：安装索引按 project_id 判重，slug 与它不是同一把钥匙
    const resolved = await provider.getFile(rule.slug, best.fileId);
    const project = resolved.project ?? (await provider.getProject?.(rule.slug).catch(() => undefined));
    return {
      provider: provider.id,
      projectId: resolved.projectId ?? rule.slug,
      // 已经选定文件：装的时候不用再挑一次版本
      versionId: best.fileId,
      name: project?.title ?? rule.name,
      slug: project?.slug ?? rule.slug,
      required: true,
      // 是否已装由调用方按实例统一判定（与来源依赖同一条路径）
      installed: false,
      kind: "mod",
      origin: "builtin",
    };
  } catch (err) {
    log.warn(`光影内置前置查询失败，本次不补：${rule.name} · ${messageOf(err)}`);
    return undefined;
  }
}
