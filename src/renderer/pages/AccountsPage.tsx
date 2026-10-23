import { useMemo, useState } from "react";
import type { Account } from "../../shared/types";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { errorMessage, useAsync } from "../lib/useAsync";
import { ConfirmDialog } from "../components/Modal";
import { Field, Select, TextInput } from "../components/Form";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import { useToast } from "../components/Toast";
import { IconLink, IconPlus, IconRefresh, IconTrash } from "../components/icons";
import { accountSiteName } from "../lib/account";
import { MicrosoftAccountCard } from "./MicrosoftAccountCard";
import { YggdrasilLoginDialog } from "./YggdrasilLoginDialog";

const NAME_RULE = /^[A-Za-z0-9_]{3,16}$/;
const AVATAR_COLORS = ["#e0a93b", "#6b9ce0", "#9bc53d", "#c07be0", "#e07b5b", "#4fbfa8"];
const TYPE_KEY: Record<Account["type"], string> = {
  offline: "pages.accounts.typeOffline",
  microsoft: "pages.accounts.typeMicrosoft",
  yggdrasil: "pages.accounts.typeYggdrasil",
};

/** 首字母头像是占位图：同一个名字始终落到同一个颜色。 */
function avatarColor(name: string): string {
  let seed = 0;
  for (const char of name) seed = (seed + char.charCodeAt(0)) % 997;
  return AVATAR_COLORS[seed % AVATAR_COLORS.length];
}

/** 第三方账号的站点标识：站点名与域名都由 lib/account 统一推导，这里只补一个兜底文案。 */
function siteOf(account: Account, fallback: string): string {
  return accountSiteName(account) || fallback;
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
  const t = useT();
  return (
    <section className="panel account-current" aria-label={t("pages.accounts.currentAria")}>
      <div className="account-head">
        <AccountAvatar account={account} />
        <div className="account-titles">
          <h2 className="account-name">{account.name}</h2>
          <div className="account-tags">
            <span className={`badge account-badge account-${account.type}`}>{t(TYPE_KEY[account.type])}</span>
            {account.type === "yggdrasil"
              ? <span className="account-site">{siteOf(account, t("pages.accounts.unknownSite"))}</span>
              : null}
            <span className="account-since">
              {t("pages.accounts.created", { date: new Date(account.createdAt).toLocaleDateString() })}
            </span>
          </div>
        </div>
        <div className="account-actions">
          <button type="button" className="btn btn-ghost btn-danger-ghost btn-icon" onClick={onDelete} title={t("pages.accounts.deleteCurrentTitle")}>
            <IconTrash size={16} />
            <span>{t("pages.accounts.delete")}</span>
          </button>
        </div>
      </div>

      <dl className="account-facts">
        <div>
          <dt>UUID</dt>
          <dd className="account-uuid">
            <code data-account-uuid>{account.uuid}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} data-copy-uuid>
              {t("pages.accounts.copy")}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t("pages.accounts.switchAccount")}</dt>
          <dd>
            <Select
              value={account.id}
              ariaLabel={t("pages.accounts.switchAccount")}
              disabled={switching || accounts.length < 2}
              onChange={onSwitch}
              options={accounts.map((item) => ({
                value: item.id,
                label: `${item.name} (${t(TYPE_KEY[item.type])})`,
              }))}
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
  const t = useT();
  const state = useAsync(() => api.accounts.list(), []);
  const accounts = useMemo(() => state.data ?? [], [state.data]);
  const [nickname, setNickname] = useState("");
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [yggOpen, setYggOpen] = useState(false);
  /** 登录时没勾「在此设备上保存」的账号：只在本会话内打「临时」标记。 */
  const [tempIds, setTempIds] = useState<string[]>([]);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});

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
    push(ok ? t("pages.accounts.uuidCopied") : t("pages.accounts.copyFailed"), ok ? "success" : "error");
  };

  const switchTo = async (id: string) => {
    if (!id || id === active?.id) return;
    setSwitching(true);
    try {
      await api.accounts.setActive(id);
      const target = accounts.find((item) => item.id === id);
      push(t("pages.accounts.switched", { name: target?.name ?? id }), "success");
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
      push(t("pages.accounts.nameRuleHint"), "error");
      return;
    }
    setCreating(true);
    try {
      const created = await api.accounts.createOffline(name);
      push(t("pages.accounts.offlineCreated", { name: created.name }), "success");
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
      push(t("pages.accounts.deleted", { name: deleting.name }), "success");
      setDeleting(null);
      await reloadAll();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyDelete(false);
    }
  };

  const handleYggdrasilLoggedIn = async (account: Account, temporary: boolean) => {
    setYggOpen(false);
    if (temporary) setTempIds((prev) => (prev.includes(account.id) ? prev : [...prev, account.id]));
    push(t("pages.accounts.yggLoggedIn", { name: account.name }), "success");
    await reloadAll();
  };

  const validateAccount = async (account: Account) => {
    setChecking((prev) => ({ ...prev, [account.id]: true }));
    setCheckErrors((prev) => {
      const next = { ...prev };
      delete next[account.id];
      return next;
    });
    try {
      const result = await api.accounts.validateYggdrasil(account.id);
      if (result.ok) {
        push(t("pages.accounts.valid", { name: account.name }), "success");
        return;
      }
      const message = (result.error ?? "").trim() || t("pages.accounts.expired");
      setCheckErrors((prev) => ({ ...prev, [account.id]: message }));
      push(message, "error");
    } catch (error: unknown) {
      const message = errorMessage(error);
      setCheckErrors((prev) => ({ ...prev, [account.id]: message }));
      push(message, "error");
    } finally {
      setChecking((prev) => {
        const next = { ...prev };
        delete next[account.id];
        return next;
      });
    }
  };

  const loading = state.loading && state.data === null;
  const nameInvalid = nickname.trim().length > 0 && !NAME_RULE.test(nickname.trim());

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("pages.accounts.title")}</h1>
          <p className="page-sub">{t("pages.accounts.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => state.reload()} disabled={state.loading}>
            <IconRefresh size={16} />
            {t("pages.accounts.refresh")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setYggOpen(true)} data-open-yggdrasil>
            <IconLink size={16} />
            {t("pages.accounts.thirdPartyLogin")}
          </button>
        </div>
      </header>

      {loading ? <SkeletonCards count={2} /> : null}

      {state.error ? <ErrorState message={state.error} onRetry={() => state.reload()} /> : null}

      {!loading && !state.error && !active ? (
        <EmptyState title={t("pages.accounts.emptyTitle")} hint={t("pages.accounts.emptyHint")} />
      ) : null}

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

      {!loading && !state.error && accounts.length > 0 ? (
        <section className="panel account-list" aria-label={t("pages.accounts.listAria")}>
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.accounts.listTitle")}</h2>
            <span className="panel-count">{t("pages.accounts.count", { count: String(accounts.length) })}</span>
          </div>
          <ul className="account-items">
            {accounts.map((item) => {
              const failed = checkErrors[item.id];
              const ygg = item.type === "yggdrasil";
              return (
                <li
                  key={item.id}
                  className={`account-item ${item.id === active?.id ? "account-item-active" : ""} ${failed ? "account-item-fail" : ""}`.trim()}
                  data-account-item={item.type}
                  data-account-id={item.id}
                >
                  <AccountAvatar account={item} />
                  <div className="account-item-main">
                    <div className="account-tags">
                      <span className="account-item-name">{item.name}</span>
                      <span className={`badge account-badge account-${item.type}`}>{t(TYPE_KEY[item.type])}</span>
                      {ygg ? (
                        <span className="account-site" data-account-site>
                          {siteOf(item, t("pages.accounts.unknownSite"))}
                        </span>
                      ) : null}
                      {tempIds.includes(item.id) ? (
                        <span className="badge account-temp">{t("pages.accounts.temp")}</span>
                      ) : null}
                      {item.id === active?.id ? (
                        <span className="account-current-tag">{t("pages.accounts.current")}</span>
                      ) : null}
                    </div>
                    {failed ? (
                      <p className="account-item-error" role="alert" data-account-check-error>
                        {t("pages.accounts.checkFailed", { error: failed })}
                      </p>
                    ) : null}
                  </div>
                  <div className="account-row">
                    {ygg ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void validateAccount(item)}
                        disabled={Boolean(checking[item.id])}
                        data-validate-yggdrasil={item.id}
                      >
                        {checking[item.id] ? t("pages.accounts.checking") : t("pages.accounts.check")}
                      </button>
                    ) : null}
                    {item.id === active?.id ? null : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void switchTo(item.id)}>
                        {t("pages.accounts.switch")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="account-grid">
        <section className="panel account-add" aria-label={t("pages.accounts.addOfflineAria")}>
          <div className="panel-head">
            <h2 className="panel-title">{t("pages.accounts.offlineTitle")}</h2>
            <span className="panel-count">{t("pages.accounts.offlineBadge")}</span>
          </div>
          <Field
            label={t("pages.accounts.nickname")}
            hint={nameInvalid
              ? t("pages.accounts.nameRuleHint")
              : t("pages.accounts.nicknameHint")}
          >
            <TextInput
              value={nickname}
              placeholder={t("pages.accounts.nicknamePlaceholder")}
              aria-label={t("pages.accounts.nicknameAria")}
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
              {creating ? t("pages.accounts.creating") : t("pages.accounts.createOffline")}
            </button>
          </div>
        </section>

        <MicrosoftAccountCard onLoggedIn={() => void reloadAll()} />
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={t("pages.accounts.deleteTitle")}
        message={deleting ? t("pages.accounts.deleteMessage", { name: deleting.name }) : ""}
        confirmText={t("pages.accounts.delete")}
        danger
        busy={busyDelete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />

      <YggdrasilLoginDialog
        open={yggOpen}
        onClose={() => setYggOpen(false)}
        onLoggedIn={(account, temporary) => void handleYggdrasilLoggedIn(account, temporary)}
      />

    </section>
  );
}
