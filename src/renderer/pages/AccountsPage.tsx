import { useMemo, useState } from "react";
import type { Account } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { ConfirmDialog } from "../components/Modal";
import { Field, Select, TextInput } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { useToast } from "../components/Toast";
import { IconPlus, IconRefresh, IconTrash } from "../components/icons";
import { MicrosoftAccountCard } from "./MicrosoftAccountCard";

const NAME_RULE = /^[A-Za-z0-9_]{3,16}$/;
const NAME_HINT = "昵称只能包含字母、数字和下划线，长度 3–16 位";
const EMPTY_TITLE = "还没有添加账号。";
const EMPTY_HINT = "离线账号可直接开始游戏；微软账号需要先在下方填写 client id。";
const AVATAR_COLORS = ["#e0a93b", "#6b9ce0", "#9bc53d", "#c07be0", "#e07b5b", "#4fbfa8"];
const TYPE_LABEL: Record<Account["type"], string> = { offline: "离线", microsoft: "微软正版" };

/** 首字母头像是占位图：同一个名字始终落到同一个颜色。 */
function avatarColor(name: string): string {
  let seed = 0;
  for (const char of name) seed = (seed + char.charCodeAt(0)) % 997;
  return AVATAR_COLORS[seed % AVATAR_COLORS.length];
}

function AccountAvatar({ account }: { account: Account }) {
  return (
    <span className="account-avatar" style={{ backgroundColor: avatarColor(account.name) }} aria-hidden="true">
      {(account.name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function CurrentAccountCard({
  account, accounts, switching, onSwitch, onDelete, onCopy,
}: {
  account: Account;
  accounts: Account[];
  switching: boolean;
  onSwitch: (id: string) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  return (
    <section className="panel account-current" aria-label="当前账号">
      <div className="account-head">
        <AccountAvatar account={account} />
        <div className="account-titles">
          <h2 className="account-name">{account.name}</h2>
          <div className="account-tags">
            <span className={`badge account-badge account-${account.type}`}>{TYPE_LABEL[account.type]}</span>
            <span className="account-since">创建于 {new Date(account.createdAt).toLocaleDateString("zh-CN")}</span>
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-danger-ghost btn-icon" onClick={onDelete} title="删除当前账号">
          <IconTrash size={16} />
          <span>删除</span>
        </button>
      </div>

      <dl className="account-facts">
        <div>
          <dt>UUID</dt>
          <dd className="account-uuid">
            <code data-account-uuid>{account.uuid}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} data-copy-uuid>
              复制
            </button>
          </dd>
        </div>
        <div>
          <dt>切换账号</dt>
          <dd>
            <Select
              value={account.id}
              ariaLabel="切换账号"
              disabled={switching || accounts.length < 2}
              onChange={onSwitch}
              options={accounts.map((item) => ({ value: item.id, label: `${item.name}（${TYPE_LABEL[item.type]}）` }))}
            />
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function AccountsPage() {
  const { settings, applySettings } = useApp();
  const { push } = useToast();
  const state = useAsync(() => api.accounts.list(), []);
  const accounts = useMemo(() => state.data ?? [], [state.data]);
  const [nickname, setNickname] = useState("");
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const active = useMemo(() => {
    const activeId = settings?.activeAccountId ?? "";
    return accounts.find((item) => item.id === activeId) ?? accounts[0] ?? null;
  }, [accounts, settings?.activeAccountId]);

  const reloadAll = async () => {
    state.reload();
    try {
      applySettings(await api.settings.get());
    } catch {
      // 设置回读失败不影响账号列表刷新
    }
  };

  const copyUuid = async (uuid: string) => {
    const ok = await copyText(uuid);
    push(ok ? "UUID 已复制" : "复制失败，请手动选择 UUID", ok ? "success" : "error");
  };

  const switchTo = async (id: string) => {
    if (!id || id === active?.id) return;
    setSwitching(true);
    try {
      await api.accounts.setActive(id);
      const target = accounts.find((item) => item.id === id);
      push(`已切换到「${target?.name ?? id}」`, "success");
      await reloadAll();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSwitching(false);
    }
  };

  const createOffline = async () => {
    const name = nickname.trim();
    if (!NAME_RULE.test(name)) {
      push(NAME_HINT, "error");
      return;
    }
    setCreating(true);
    try {
      const created = await api.accounts.createOffline(name);
      push(`离线账号「${created.name}」已创建`, "success");
      try {
        await api.accounts.setActive(created.id);
      } catch (error: unknown) {
        push(errorMessage(error), "error");
      }
      setNickname("");
      await reloadAll();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await api.accounts.remove(deleting.id);
      push(`账号「${deleting.name}」已删除`, "success");
      setDeleting(null);
      await reloadAll();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyDelete(false);
    }
  };

  const loading = state.loading && state.data === null;
  const nameInvalid = nickname.trim().length > 0 && !NAME_RULE.test(nickname.trim());

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">账号</h1>
          <p className="page-sub">离线账号输入昵称即可开始游戏；微软正版账号走设备码登录，可进入正版服务器。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => state.reload()} disabled={state.loading}>
            <IconRefresh size={16} />
            刷新
          </button>
        </div>
      </header>

      {loading ? <SkeletonCards count={2} /> : null}

      {state.error ? <ErrorState message={state.error} onRetry={() => state.reload()} /> : null}

      {!loading && !state.error && !active ? <EmptyState title={EMPTY_TITLE} hint={EMPTY_HINT} /> : null}

      {!loading && !state.error && active ? (
        <CurrentAccountCard
          account={active}
          accounts={accounts}
          switching={switching}
          onSwitch={(id) => void switchTo(id)}
          onDelete={() => setDeleting(active)}
          onCopy={() => void copyUuid(active.uuid)}
        />
      ) : null}

      <div className="account-grid">
        <section className="panel account-add" aria-label="添加离线账号">
          <div className="panel-head">
            <h2 className="panel-title">离线账号</h2>
            <span className="panel-count">无需联网</span>
          </div>
          <Field label="昵称" hint={nameInvalid ? NAME_HINT : "3–16 位字母、数字或下划线，创建后自动设为当前账号"}>
            <TextInput
              value={nickname}
              placeholder="例如 Steve_01"
              aria-label="离线账号昵称"
              maxLength={16}
              onChange={(event) => setNickname(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createOffline();
              }}
            />
          </Field>
          <div className="account-actions">
            <button type="button" className="btn btn-primary" onClick={() => void createOffline()} disabled={creating}>
              <IconPlus size={16} />
              {creating ? "创建中…" : "创建离线账号"}
            </button>
          </div>
        </section>

        <MicrosoftAccountCard onLoggedIn={() => void reloadAll()} />
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="删除账号"
        message={deleting ? `确定删除账号「${deleting.name}」吗？该账号的登录凭据会一并移除，且无法恢复。` : ""}
        confirmText="删除"
        danger
        busy={busyDelete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
