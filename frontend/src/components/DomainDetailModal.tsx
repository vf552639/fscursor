import React, { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";

import {
  Domain,
  SetNameserversVars,
  useCancelSsl,
  useCreateDb,
  useCreateSite,
  useDbCredentials,
  useGetNginxOverride,
  useRefreshSsl,
  useRequestSsl,
  useSetNginxOverride,
  useSetNameservers,
  normalizeNameservers,
  MIN_NAMESERVERS,
  NS_DESKTOP_NOTE,
  SET_NAMESERVERS_KEY,
} from "../api/domains";
import { useZoneNameservers } from "../api/cloudflare";
import { isTauri } from "../lib/runtime";
import { Btn, Modal } from "./ui/Primitives";

/**
 * Разбор поля NS: по одному на строку, но запятые и лишние пробелы прощаем.
 * Разделитель уже съедает пробелы, поэтому дополнительный `trim` тут не нужен —
 * нормализацию (регистр, дубли) делает `normalizeNameservers` перед отправкой.
 */
function parseNameservers(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

type Tab = "overview" | "db" | "ssl" | "nginx" | "ns";

export default function DomainDetailModal({
  domain,
  onClose,
}: {
  domain: Domain;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [snippet, setSnippet] = useState("");
  const [presets, setPresets] = useState({
    force_https: false,
    www_redirect: false,
    custom_404: false,
    basic_auth: false,
  });

  const createSite = useCreateSite();
  const createDb = useCreateDb();
  const dbCreds = useDbCredentials(domain.id);
  const requestSsl = useRequestSsl();
  const cancelSsl = useCancelSsl();
  const refreshSsl = useRefreshSsl();
  const setNs = useSetNameservers();
  const setNginx = useSetNginxOverride();
  const nginxOverride = useGetNginxOverride(domain.id);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Вкладка, которой принадлежит текущая ошибка. Баннер один на всю модалку и
   * живёт между попытками (`key` меняется только при смене домена), поэтому
   * одного лишь сброса в начале действия мало: ошибка Create DB переезжала на
   * вкладку NS, где такого действия нет вовсе, и там ещё и заслоняла ошибку
   * Set NS. Каждое действие живёт ровно на одной вкладке (`overview` — Create
   * Site, `db` — Create DB, `ssl` — три кнопки SSL, `nginx` — override, `ns` —
   * Set NS), так что «показывать отчёт только там, где нажимали» — это и есть
   * правило.
   */
  const [actionErrorTab, setActionErrorTab] = useState<Tab | null>(null);

  /**
   * Каждое действие начинается с чистого баннера: без сброса красное про
   * прошлый отказ висело бы над удавшейся следующей попыткой, а повтор на
   * месте здесь основной сценарий.
   */
  const runAction = (fn: () => void) => {
    setActionError(null);
    setActionErrorTab(tab);
    fn();
  };

  /**
   * Отказ смены NS переживает закрытие карточки: читаем последнюю попытку по
   * этому домену прямо из MutationCache, а не через per-call `onError`, который
   * при размонтировании глушится. «Последнюю» — потому что предыдущие записи
   * лежат там ещё gcTime, и удавшийся повтор обязан гасить красное от прошлого
   * отказа.
   */
  const setNsStates = useMutationState({
    filters: {
      mutationKey: SET_NAMESERVERS_KEY,
      predicate: (m) => (m.state.variables as SetNameserversVars | undefined)?.domainId === domain.id,
    },
    select: (m) => ({ status: m.state.status, error: m.state.error }),
  });
  const lastSetNs = setNsStates[setNsStates.length - 1];
  const setNsError =
    lastSetNs?.status === "error"
      ? String((lastSetNs.error as any)?.message || "Set NS failed")
      : null;

  /**
   * Баннер принадлежит вкладке, на которой запущено действие, — по одной и той
   * же причине для обеих половин.
   *
   * `setNsError` живёт в MutationCache и `runAction` его не касается: без
   * скоупа отказ Set NS висел бы красным над удавшимся Create DB на соседней
   * вкладке и встречал бы на Overview пользователя, который в этой сессии
   * ничего не нажимал. `actionError` живёт в стейте модалки и переживает
   * переключение вкладок: без скоупа он показывался бы на NS, где такого
   * действия нет, да ещё и заслонял бы собой `setNsError`.
   *
   * Скоуп не прячет отказ Set NS насовсем: на своей вкладке он по-прежнему
   * виден и после закрытия и повторного открытия карточки (это задумано —
   * ответ регистратора может прийти уже после закрытия). Долговременный след
   * — `ns_status: error` в строке таблицы.
   */
  const banner = (actionErrorTab === tab ? actionError : null) ?? (tab === "ns" ? setNsError : null);

  // NS зоны Cloudflare — источник по умолчанию: в этом продукте «Set NS» почти
  // всегда значит «прописать регистратору те NS, что выдал Cloudflare». Но поле
  // редактируемое: домен без зоны CF (или уезжающий на чужой хостинг) иначе был
  // бы заперт, а команда список NS сама не добывает.
  //
  // Запрос — только на своей вкладке: `cf_list_zones` листает аккаунт по 50 зон,
  // и платить за это при открытии карточки на вкладке SSL незачем. Ключ кэша
  // общий с остальными потребителями зон, так что переключение вкладок туда-сюда
  // второго похода не стоит.
  const zoneNs = useZoneNameservers(
    tab === "ns" ? domain.cloudflare_account_id : null,
    domain.cloudflare_zone_id
  );
  const [nsText, setNsText] = useState("");
  // Два разных факта, и путать их нельзя. `nsEdited` — «пользователь трогал
  // поле», `nsPrefilled` — «подстановку уже сделали». Пока признаком второго
  // служил сам текст, стирание backspace'ом проходило через пустую строку,
  // поле мгновенно наполнялось NS зоны обратно, и следующие backspace'ы
  // стирали уже их.
  const [nsEdited, setNsEdited] = useState(false);
  const [nsPrefilled, setNsPrefilled] = useState(false);
  const zoneNsList = zoneNs.data?.name_servers ?? [];
  // Нормализуем ТУТ же, а не только внутри хука: кнопка гасится по числу NS, и
  // без схлопывания дублей «ns1 + NS1» выглядели бы как два — кнопка живая,
  // мутация падает. Гейт и отправка обязаны считать одинаково; в хуке
  // нормализация остаётся как единственная гарантия для второго вызывающего.
  const nameservers = useMemo(() => normalizeNameservers(parseNameservers(nsText)), [nsText]);

  React.useEffect(() => {
    // Подставляем РОВНО ОДИН раз и только если пользователь ещё не печатал:
    // иначе поздний ответ Cloudflare затирал бы набранное руками, а стирание
    // поля воскрешало бы NS зоны под курсором.
    if (nsEdited || nsPrefilled) return;
    const fromZone = zoneNs.data?.name_servers ?? [];
    if (fromZone.length === 0) return;
    setNsText(fromZone.join("\n"));
    setNsPrefilled(true);
  }, [zoneNs.data, nsEdited, nsPrefilled]);

  React.useEffect(() => {
    if (nginxOverride.data) {
      setSnippet(nginxOverride.data.snippet || "");
      const p = nginxOverride.data.presets || {};
      setPresets({
        force_https: Boolean(p.force_https),
        www_redirect: Boolean(p.www_redirect),
        custom_404: Boolean(p.custom_404),
        basic_auth: Boolean(p.basic_auth),
      });
    }
  }, [nginxOverride.data]);

  const sslLabel = useMemo(() => {
    if (domain.ssl_status === "active") return `Active${domain.ssl_expires_at ? ` (exp: ${new Date(domain.ssl_expires_at).toLocaleDateString()})` : ""}`;
    if (domain.ssl_status === "pending") return "Pending";
    if (domain.ssl_status === "error") return "Error";
    return "None";
  }, [domain.ssl_expires_at, domain.ssl_status]);

  return (
    <Modal title={`Domain: ${domain.domain_name}`} onClose={onClose} width={760}>
      {banner ? (
        <div role="alert" style={{ marginBottom: 10, fontSize: 12.5, color: "#991b1b", background: "#fee2e2", borderRadius: 8, padding: "8px 10px" }}>
          {banner}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["overview", "db", "ssl", "nginx", "ns"] as Tab[]).map((t) => (
          <Btn key={t} variant={tab === t ? "primary" : "secondary"} size="sm" onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </Btn>
        ))}
      </div>

      {tab === "overview" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 8 }}>
          <div><b>Status:</b> {domain.status}</div>
          <div><b>Server:</b> {domain.server_id ?? "—"}</div>
          <div><b>Registrar:</b> {domain.registrar_id ?? "—"}</div>
          <div><b>Cloudflare:</b> {domain.cloudflare_account_id ?? "—"}</div>
          <div><b>NS:</b> {domain.ns_status ?? "pending"} ({domain.ns_check_mode ?? "auto"})</div>
          <div><b>Last error:</b> {domain.last_provision_error || "—"}</div>
          <div style={{ marginTop: 10 }}>
            <Btn
              variant="secondary"
              onClick={() => runAction(() => createSite.mutate({ domainId: domain.id, site_only: true }, { onError: (e: any) => setActionError(e?.message || "Create site failed") }))}
              disabled={createSite.isPending}
            >
              {createSite.isPending ? "Starting..." : "Create Site"}
            </Btn>
          </div>
        </div>
      )}

      {tab === "db" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>DB name:</b> {dbCreds.data?.db_name ?? domain.db_name ?? "—"}</div>
          <div><b>DB user:</b> {dbCreds.data?.db_user ?? domain.db_user ?? "—"}</div>
          <div><b>DB password:</b> {dbCreds.data?.db_password ?? "—"}</div>
          <Btn variant="secondary" onClick={() => runAction(() => createDb.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Create DB failed") }))} disabled={createDb.isPending}>
            {createDb.isPending ? "Creating..." : "Create DB"}
          </Btn>
        </div>
      )}

      {tab === "ssl" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>Status:</b> {sslLabel}</div>
          <div><b>Issuer:</b> {domain.ssl_issuer ?? "—"}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={() => runAction(() => requestSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Request SSL failed") }))} disabled={requestSsl.isPending}>
              Request SSL
            </Btn>
            <Btn variant="secondary" onClick={() => runAction(() => refreshSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Refresh SSL failed") }))} disabled={refreshSsl.isPending}>
              Refresh SSL
            </Btn>
            <Btn variant="danger" onClick={() => runAction(() => cancelSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Cancel SSL failed") }))} disabled={cancelSsl.isPending}>
              Cancel SSL
            </Btn>
          </div>
        </div>
      )}

      {tab === "nginx" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <label><input type="checkbox" checked={presets.force_https} onChange={(e) => setPresets((p) => ({ ...p, force_https: e.target.checked }))} /> Force HTTPS</label>
          <label><input type="checkbox" checked={presets.www_redirect} onChange={(e) => setPresets((p) => ({ ...p, www_redirect: e.target.checked }))} /> www -&gt; non-www</label>
          <label><input type="checkbox" checked={presets.custom_404} onChange={(e) => setPresets((p) => ({ ...p, custom_404: e.target.checked }))} /> custom 404</label>
          <label><input type="checkbox" checked={presets.basic_auth} onChange={(e) => setPresets((p) => ({ ...p, basic_auth: e.target.checked }))} /> basic auth</label>
          <textarea
            value={snippet}
            onChange={(e) => setSnippet(e.target.value)}
            placeholder="Custom nginx snippet"
            style={{ width: "100%", minHeight: 140, borderRadius: 8, border: "1px solid #e5e7eb", padding: 8, fontFamily: "monospace" }}
          />
          <div style={{ fontSize: 12, color: "#6b7280", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap" }}>
            Preview:
            {"\n"}
            {(presets.force_https ? "if ($scheme = http) { return 301 https://$host$request_uri; }\n" : "") +
              (presets.www_redirect ? `if ($host = "www.${domain.domain_name}") { return 301 https://${domain.domain_name}$request_uri; }\n` : "") +
              snippet}
          </div>
          <Btn
            variant="secondary"
            onClick={() =>
              runAction(() =>
                setNginx.mutate(
                  { domainId: domain.id, data: { snippet, presets } },
                  { onError: (e: any) => setActionError(e?.message || "Save nginx override failed") }
                )
              )
            }
            disabled={setNginx.isPending}
          >
            Save and Reload nginx
          </Btn>
        </div>
      )}

      {tab === "ns" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>NS status:</b> {domain.ns_status ?? "pending"}</div>
          {/* «Check NS» / «Mark NS set» / «Unmark NS» здесь были и удалены:
              роутов `check-ns` и `mark-ns-set` на бэкенде не существует, так что
              все три всегда давали 404 — в десктопе в общий баннер, а на вебе
              вдобавок стояли ВКЛЮЧЁННЫМИ прямо под строкой «Read-only here».
              Перевести их на Tauri-команду нечем: проверка делегирования — это
              DNS-резолв, которого в десктопе нет. Вкладка честно осталась с тем
              одним действием, которое работает. */}
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <label htmlFor="ns-list" style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Nameservers (one per line)
              </label>
              {/* Подстановка теперь одноразовая, поэтому вернуть NS зоны после
                  правки нечем: их списка в этой модалке нет. Явная ссылка
                  вместо прежнего неявного «очистка = сброс», который воскрешал
                  NS прямо под курсором при стирании backspace'ом. */}
              {zoneNsList.length > 0 && nsText !== zoneNsList.join("\n") ? (
                <button
                  type="button"
                  onClick={() => { setNsEdited(true); setNsText(zoneNsList.join("\n")); }}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "#2563eb", textDecoration: "underline" }}
                >
                  ↺ Restore from Cloudflare
                </button>
              ) : null}
            </div>
            <textarea
              id="ns-list"
              value={nsText}
              onChange={(e) => { setNsEdited(true); setNsText(e.target.value); }}
              placeholder={"ns1.example.com\nns2.example.com"}
              style={{ width: "100%", minHeight: 88, borderRadius: 8, border: "1px solid #e5e7eb", padding: 8, fontFamily: "monospace", fontSize: 12.5 }}
            />
            {/* Вне десктопа всё ниже — следствие одного и того же: выполнять
                нечего и читать зону нечем. Три янтарных строки на одну причину
                («не смогли прочитать Cloudflare», «добавьте NS выше», «только
                чтение») противоречат друг другу: первая выдаёт правило продукта
                за поломку, вторая предлагает то, чего на вебе не сделать.
                Оставляем одну — ту, которая называет настоящую причину. */}
            {isTauri() ? (
              <>
                {/* Молчаливое пустое поле не отличить от «у зоны нет NS» — а
                    разница между «не смогли прочитать» и «нечего показывать»
                    здесь и есть ответ на вопрос пользователя. */}
                {zoneNs.isError ? (
                  <div style={{ fontSize: 12, color: "#b45309" }}>
                    Could not prefill from Cloudflare: {String((zoneNs.error as any)?.message || "unknown error")}
                  </div>
                ) : null}
                {domain.registrar_id == null ? (
                  <div style={{ fontSize: 12, color: "#b45309" }}>
                    Assign a registrar account to this domain first — SDMP pushes NS through the registrar API.
                  </div>
                ) : null}
                {/* Выключенная кнопка без объяснения — это загадка, а не запрет.
                    Каждое условие в `disabled` ниже имеет свою строчку. */}
                {domain.registrar_id != null && nameservers.length < MIN_NAMESERVERS ? (
                  <div style={{ fontSize: 12, color: "#b45309" }}>
                    Nothing to push: enter at least {MIN_NAMESERVERS} distinct nameservers above.
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#92400e" }}>Read-only here. {NS_DESKTOP_NOTE}</div>
            )}
            <div>
              <Btn
                variant="secondary"
                // Без per-call `onError`: ошибку показывает `setNsError`,
                // прочитанный из MutationCache. Per-call коллбэк умер бы вместе
                // с размонтированием, а отказ регистратора может прилететь уже
                // после закрытия карточки.
                onClick={() =>
                  runAction(() =>
                    setNs.mutate({
                      domainId: domain.id,
                      domainName: domain.domain_name,
                      registrarAccountId: domain.registrar_id,
                      nameservers,
                    })
                  )
                }
                disabled={
                  setNs.isPending ||
                  !isTauri() ||
                  domain.registrar_id == null ||
                  nameservers.length < MIN_NAMESERVERS
                }
              >
                {setNs.isPending ? "Setting NS..." : "Set NS"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
