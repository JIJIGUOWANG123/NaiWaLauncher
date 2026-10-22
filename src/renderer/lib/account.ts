import type { Account } from "../../shared/types";

/** 第三方账号的站点标识：后端给了 siteName 就用它，否则退回 API 域名（都没有时返回空串）。 */
export function accountSiteName(account: Account): string {
  const named = account.yggdrasil?.siteName?.trim();
  if (named) return named;
  const apiUrl = account.yggdrasil?.apiUrl ?? "";
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}
