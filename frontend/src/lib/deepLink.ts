import { invoke } from "@tauri-apps/api/core";

/**
 * Результат команды `install_fastpanel` (см. `InstallFastpanelResult` в
 * `commands/provision.rs`). Пароль панели существует ТОЛЬКО здесь: он нигде не
 * сохраняется — ни на сервере, ни в кэше. Не писать в localStorage, в кэш
 * запросов и в логи.
 */
export interface InstallFastpanelResult {
  server_id: string;
  url: string | null;
  user: string | null;
  password: string | null;
}

/** Что сделал deep link. `handled: false` — ссылка не наша, вызывающий тостит. */
export type DeepLinkOutcome =
  | { handled: false }
  | { handled: true; fastpanel?: InstallFastpanelResult };

/** Parse `sdmp://…` URLs from the desktop app or web CTAs. */
export function parseSdmpDeepLink(url: string): URL | null {
  try {
    if (!url.startsWith("sdmp:")) return null;
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Handle deep links inside Tauri: provision / bulk provision / install FastPanel.
 * Other URLs are ignored (caller may toast).
 */
export async function handleSdmpDeepLinkInTauri(
  url: string,
  userId: string | null,
): Promise<DeepLinkOutcome> {
  const u = parseSdmpDeepLink(url);
  if (!u || !userId) return { handled: false };
  const host = u.hostname.toLowerCase();

  if (host === "provision") {
    const id = u.searchParams.get("domainId") || u.searchParams.get("id");
    if (!id) return { handled: false };
    await invoke("provision_domain", {
      userId,
      domainId: id,
      siteOnly: false,
    });
    return { handled: true };
  }

  if (host === "bulk-provision") {
    const ids =
      u.searchParams
        .get("ids")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (ids.length === 0) return { handled: false };
    await invoke("provision_bulk", { userId, domainIds: ids });
    return { handled: true };
  }

  if (host === "install-fastpanel") {
    const sid = u.searchParams.get("serverId") || u.searchParams.get("id");
    if (!sid) return { handled: false };
    // Креды панели живут только в этом ответе — обязательно отдаём их наверх,
    // иначе после 30 минут установки пароль потерян безвозвратно.
    const res = await invoke<InstallFastpanelResult>("install_fastpanel", {
      userId,
      serverId: sid,
      force: false,
    });
    return { handled: true, fastpanel: res };
  }

  return { handled: false };
}
