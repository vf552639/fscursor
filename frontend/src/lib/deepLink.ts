import { invokeSynced } from "./localCache";

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

/**
 * Что сделал deep link. `handled: false` — ссылка не наша, вызывающий тостит.
 * `cancelled: true` — ссылка наша, но пользователь не подтвердил выполнение.
 */
export type DeepLinkOutcome =
  | { handled: false }
  | { handled: true; cancelled?: boolean; fastpanel?: InstallFastpanelResult };

/**
 * Действие, которое просит выполнить ссылка. Все три — ИСПОЛНЯЮЩИЕ: каждое
 * лезет по SSH на живой сервер. Навигационных `sdmp://` пока нет; если
 * появятся — они разбираются отдельной веткой и без подтверждения.
 */
export type DeepLinkAction =
  | { kind: "provision"; domainId: string }
  | { kind: "bulk-provision"; domainIds: string[] }
  | { kind: "install-fastpanel"; serverId: string };

/** Parse `sdmp://…` URLs from the desktop app or web CTAs. */
export function parseSdmpDeepLink(url: string): URL | null {
  try {
    if (!url.startsWith("sdmp:")) return null;
    return new URL(url);
  } catch {
    return null;
  }
}

/** Разобрать ссылку в действие. `null` — ссылка не наша или без цели. */
export function parseDeepLinkAction(url: string): DeepLinkAction | null {
  const u = parseSdmpDeepLink(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();

  if (host === "provision") {
    const id = u.searchParams.get("domainId") || u.searchParams.get("id");
    return id ? { kind: "provision", domainId: id } : null;
  }

  if (host === "bulk-provision") {
    const ids =
      u.searchParams
        .get("ids")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    return ids.length > 0 ? { kind: "bulk-provision", domainIds: ids } : null;
  }

  if (host === "install-fastpanel") {
    const sid = u.searchParams.get("serverId") || u.searchParams.get("id");
    return sid ? { kind: "install-fastpanel", serverId: sid } : null;
  }

  return null;
}

/**
 * Текст подтверждения: обязательно называет и действие, и конкретную цель —
 * иначе пользователь не может понять, что именно он разрешает.
 */
export function describeDeepLinkAction(action: DeepLinkAction): string {
  switch (action.kind) {
    case "provision":
      return (
        `Provision domain #${action.domainId}?\n\n` +
        "SDMP will connect over SSH to that domain's server and create the site, " +
        "its FTP account and its SSL certificate.\n\n" +
        "Continue only if you started this yourself."
      );
    case "bulk-provision": {
      const list = action.domainIds.join(", ");
      return (
        `Provision ${action.domainIds.length} domain(s)?\n\n` +
        `Domain ids: ${list}\n\n` +
        "SDMP will connect over SSH to each domain's server and create the site, " +
        "its FTP account and its SSL certificate.\n\n" +
        "Continue only if you started this yourself."
      );
    }
    case "install-fastpanel":
      return (
        `Install FastPanel on server #${action.serverId}?\n\n` +
        "SDMP will connect over SSH to that server, upgrade every installed package " +
        "and run the FastPanel installer. This takes 30+ minutes and reboots services " +
        "on a live server.\n\n" +
        "Continue only if you started this yourself."
      );
  }
}

/** Подтверждение выполнения. Возврат `false` — не выполнять. */
export type ConfirmDeepLink = (message: string) => boolean;

// window.confirm, а не Modal: подтверждение здесь — это gate перед вызовом,
// который стартует сразу, а обработчик ссылки живёт вне рендера React (внутри
// колбэка onOpenUrl). Modal потребовал бы прокинуть pending-действие в стейт и
// ждать ответ через промис; window.confirm — синхронный, блокирующий, его нельзя
// подделать содержимым страницы, и ровно им же в DesktopWorkspace подтверждается
// столь же критичный `ssh:host-key-prompt`.
const defaultConfirm: ConfirmDeepLink = (message) =>
  typeof window === "undefined" ? false : window.confirm(message);

/**
 * Handle deep links inside Tauri: provision / bulk provision / install FastPanel.
 * Other URLs are ignored (caller may toast).
 *
 * Любая `sdmp://`-ссылка может прилететь с произвольной веб-страницы, поэтому
 * ни одно действие не выполняется без явного подтверждения пользователя.
 */
export async function handleSdmpDeepLinkInTauri(
  url: string,
  userId: string | null,
  confirmAction: ConfirmDeepLink = defaultConfirm,
): Promise<DeepLinkOutcome> {
  const action = parseDeepLinkAction(url);
  if (!action || !userId) return { handled: false };

  if (!confirmAction(describeDeepLinkAction(action))) {
    return { handled: true, cancelled: true };
  }

  if (action.kind === "provision") {
    await invokeSynced("provision_domain", {
      userId,
      domainId: action.domainId,
      siteOnly: false,
    });
    return { handled: true };
  }

  if (action.kind === "bulk-provision") {
    await invokeSynced("provision_bulk", { userId, domainIds: action.domainIds });
    return { handled: true };
  }

  // Креды панели живут только в этом ответе — обязательно отдаём их наверх,
  // иначе после 30 минут установки пароль потерян безвозвратно.
  const res = await invokeSynced<InstallFastpanelResult>("install_fastpanel", {
    userId,
    serverId: action.serverId,
    force: false,
  });
  return { handled: true, fastpanel: res };
}
