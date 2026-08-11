import React, { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";

import {
  Domain,
  SetNameserversVars,
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

/** Один и тот же список NS? Регистр и порядок записи в поле роли не играют. */
function sameNameservers(a: string[], b: string[]): boolean {
  const norm = (list: string[]) =>
    normalizeNameservers(list)
      .map((ns) => ns.toLowerCase())
      .join("\n");
  return norm(a) === norm(b);
}

/**
 * Осталось две вкладки из пяти. `db`, `ssl` и `nginx` (и кнопка «Create Site» на
 * `overview`) удалены целиком: их действия били в `POST /domains/{id}/create-db`,
 * `/ssl-request`, `/ssl-cancel`, `/refresh-ssl`, `/nginx-override`,
 * `/create-site` и `GET /domains/{id}/db-credentials`, которых на бэкенде нет —
 * все они всегда давали 404. Вернуть их можно только новыми Tauri-командами с
 * SSH-логикой, это отдельная функция со своим планом, а не достижимость.
 */
type Tab = "overview" | "ns";

export default function DomainDetailModal({
  domain,
  onClose,
}: {
  domain: Domain;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");

  const setNs = useSetNameservers();

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
   * Баннер принадлежит вкладке, на которой запущено действие. Действие теперь
   * ровно одно (Set NS на вкладке `ns`), поэтому карта «ошибка на каждую
   * вкладку» вместе с `runAction` удалена следом за вкладками, которые её
   * наполняли: с единственным источником ей нечего разводить. Скоуп по вкладке
   * при этом остался — он про другое и продолжает работать: без него отказ Set
   * NS встречал бы на Overview пользователя, который в этой сессии ничего не
   * нажимал.
   *
   * Скоуп не прячет отказ насовсем: на своей вкладке он по-прежнему виден и
   * после закрытия и повторного открытия карточки (это задумано — ответ
   * регистратора может прийти уже после закрытия). Долговременный след —
   * `ns_status: error` в строке таблицы.
   */
  const banner = tab === "ns" ? setNsError : null;

  // NS зоны Cloudflare — источник по умолчанию: в этом продукте «Set NS» почти
  // всегда значит «прописать регистратору те NS, что выдал Cloudflare». Но поле
  // редактируемое: домен без зоны CF (или уезжающий на чужой хостинг) иначе был
  // бы заперт, а команда список NS сама не добывает.
  //
  // Запрос — только на своей вкладке: `cf_list_zones` листает аккаунт по 50 зон,
  // и платить за это при открытии карточки на Overview незачем (а открывается
  // она всегда на нём). Ключ кэша общий с остальными потребителями зон, так что
  // переключение вкладок туда-сюда второго похода не стоит.
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

  return (
    <Modal title={`Domain: ${domain.domain_name}`} onClose={onClose} width={760}>
      {banner ? (
        <div role="alert" style={{ marginBottom: 10, fontSize: 12.5, color: "#991b1b", background: "#fee2e2", borderRadius: 8, padding: "8px 10px" }}>
          {banner}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["overview", "ns"] as Tab[]).map((t) => (
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
              {/* Сравниваем НОРМАЛИЗОВАННЫЕ списки, а не текст посимвольно:
                  лишний перевод строки в конце — не повод предлагать
                  восстановление того, что и так уже в поле. */}
              {zoneNsList.length > 0 && !sameNameservers(nameservers, zoneNsList) ? (
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
                  setNs.mutate({
                    domainId: domain.id,
                    domainName: domain.domain_name,
                    registrarAccountId: domain.registrar_id,
                    nameservers,
                  })
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
