import { confirmAction as nativeConfirm } from "./confirmDialog";
import { invokeSynced } from "./localCache";
import {
  runBulkProvisionDomains,
  runProvisionDomain,
  type BulkProvisionOutcome,
  type ProvisionOutcome,
} from "../api/domains";

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
 *
 * `fastpanel`, `provision` и `bulkProvision` — результаты, которые существуют
 * только здесь: пароль панели, пароли БД и FTP. Вызывающий обязан показать их
 * один раз; потерять их — значит оставить пользователя с аккаунтами, войти в
 * которые он не сможет никогда. У `bulkProvision` таких результатов сразу
 * несколько — по одному на отработавший домен, и потерять можно все N.
 */
export type DeepLinkOutcome =
  | { handled: false }
  | {
      handled: true;
      cancelled?: boolean;
      fastpanel?: InstallFastpanelResult;
      provision?: ProvisionOutcome;
      bulkProvision?: BulkProvisionOutcome;
    };

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
export type ConfirmDeepLink = (message: string) => boolean | Promise<boolean>;

// Нативный диалог, а не Modal и не `window.confirm`. Не Modal — потому что
// подтверждение здесь это gate перед вызовом, который стартует сразу, а
// обработчик ссылки живёт вне рендера React (внутри колбэка onOpenUrl); Modal
// потребовал бы прокинуть pending-действие в стейт. Не `window.confirm` —
// потому что в десктопе он не показывает ничего и возвращает `false`
// (см. `confirmDialog.ts`): пока здесь стоял он, КАЖДАЯ `sdmp://`-ссылка молча
// отменялась, и выглядело это как «ссылки не работают».
//
// Свойство, ради которого диалог тут вообще есть, нативный сохраняет: его
// нельзя подделать содержимым страницы, а страница по ссылке приходит чужая.
const defaultConfirm: ConfirmDeepLink = nativeConfirm;

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

  if (!(await confirmAction(describeDeepLinkAction(action)))) {
    return { handled: true, cancelled: true };
  }

  if (action.kind === "provision") {
    // Через мутацию, а не напрямую: у ссылки тот же `PROVISION_DOMAIN_KEY`, что
    // у кнопки, поэтому страница видит запущенный по ссылке provision и не даёт
    // запустить по тому же домену второй.
    //
    // БД по ссылке не создаётся (`withDb: false`): выбор «создавать ли базу»
    // делается чекбоксом в диалоге, а хост `provision` такого параметра не
    // знает — молча создать базу по ссылке значит сделать за пользователя
    // выбор, которого он не делал.
    const provision = await runProvisionDomain({
      domainId: Number(action.domainId),
      // Имени домена у ссылки нет — она адресует по id; та же форма, что и в
      // тексте подтверждения выше («Provision domain #3?»).
      domainName: `#${action.domainId}`,
      withDb: false,
    });
    // Результат ОБЯЗАТЕЛЬНО отдаём наверх: FTP-аккаунт создаётся на каждом
    // не-`site_only` прогоне, а его пароль возвращается только в этом ответе.
    return { handled: true, provision };
  }

  if (action.kind === "bulk-provision") {
    // Не прямой `invokeSynced`, а тот же путь, что у одиночного provision, и по
    // тем же двум причинам.
    //
    // 1. Результат. На каждом домене создаётся FTP-аккаунт, пароль которого
    //    возвращается только в этом ответе. Прямой вызов отдавал наружу один
    //    ключ идемпотентности, а `Ok` каждого домена отбрасывал — N аккаунтов,
    //    войти в которые пользователь не сможет никогда.
    // 2. Гейт. Он подоменный и живёт в `MutationCache`; прямой вызов его не
    //    консультировал, поэтому ссылка спокойно открывала вторую SSH-сессию по
    //    домену, который уже провижинится кнопкой `Provision` на карточке
    //    домена или другой ссылкой.
    const bulkProvision = await runBulkProvisionDomains(userId, action.domainIds);
    return { handled: true, bulkProvision };
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
