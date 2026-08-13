import React, { useMemo, useState } from "react";
import { useMutationState } from "@tanstack/react-query";

import { clip, errorText } from "../../api/cfAutoBind";
import {
  Domain,
  MIN_NAMESERVERS,
  NS_DESKTOP_NOTE,
  SET_NAMESERVERS_KEY,
  SetNameserversVars,
  normalizeNameservers,
  useSetNameservers,
} from "../../api/domains";
import { NsDelegation, nsDelegationVariant } from "../../lib/nsDelegation";
import { registrarSupportsNsApi } from "../../lib/registrarCaps";
import { isTauri } from "../../lib/runtime";
import { Badge, Btn } from "../ui/Primitives";

const WARN_TEXT = "#b45309";

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

export interface DomainNsPanelProps {
  domain: Domain;
  /** NS зоны Cloudflare: подстановка в поле и «эталон» сверки. Пусто — зоны нет или она не прочитана. */
  zoneNameservers: string[];
  /** Отказ чтения зон аккаунта — причина, по которой подстановка пуста. */
  zonesError: unknown;
  /** Итог сверки «NS зоны против NS у регистратора» (`lib/nsDelegation`). */
  delegation: NsDelegation;
  /** `provider` аккаунта регистратора; `undefined` — аккаунт ещё не прочитан. */
  registrarProvider: string | null | undefined;
}

/**
 * Nameservers домена: что у зоны, что у регистратора и чем их свести.
 *
 * Стоит на том же экране, что и аккаунт Cloudflare, потому что отвечает на ту
 * же половину вопроса: пустое поле NS и погасшая кнопка — это почти всегда
 * следствие нерезолвнутой зоны, и разведённые по вкладкам причина и следствие
 * читаются как две независимые поломки.
 *
 * Выполняет ТОЛЬКО десктоп (`registrar_set_nameservers`): API-ключ регистратора
 * расшифровывается на клиенте, и HTTP-роута под смену NS на бэкенде нет.
 */
export default function DomainNsPanel({
  domain,
  zoneNameservers,
  zonesError,
  delegation,
  registrarProvider,
}: DomainNsPanelProps) {
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

  const [nsText, setNsText] = useState("");
  /**
   * Трогал ли поле пользователь. Признак нужен отдельным флагом, а не «текст
   * непустой»: стирание backspace'ом проходит через пустую строку, и по тексту
   * поле в этот момент наполнялось бы NS зоны обратно — следующие backspace'ы
   * стирали бы уже их.
   */
  const [nsEdited, setNsEdited] = useState(false);
  // Нормализуем ТУТ же, а не только внутри хука: кнопка гасится по числу NS, и
  // без схлопывания дублей «ns1 + NS1» выглядели бы как два — кнопка живая,
  // мутация падает. Гейт и отправка обязаны считать одинаково; в хуке
  // нормализация остаётся как единственная гарантия для второго вызывающего.
  const nameservers = useMemo(() => normalizeNameservers(parseNameservers(nsText)), [nsText]);

  /**
   * Нетронутое поле ЗЕРКАЛИТ nameservers текущей зоны — включая случай, когда
   * зоны не стало.
   *
   * Одноразовой подстановки тут мало, и это не теория: карточка не
   * пересоздаётся при смене аккаунта Cloudflare (`key` у неё — id домена), а
   * смена аккаунта обнуляет `cloudflare_zone_id`. Подставленные раньше NS зоны
   * СТАРОГО аккаунта оставались бы в поле, ссылка «Restore from Cloudflare»
   * при этом исчезала (сравнивать не с чем), и кнопка оставалась живой — то
   * есть одним кликом регистратору уезжали nameservers аккаунта, от которого
   * пользователь только что отказался.
   *
   * Зеркалит только пока пользователь не печатал: поздний ответ Cloudflare не
   * вправе затирать набранное руками, а домен без зоны CF (или уезжающий на
   * чужой хостинг) обязан оставаться заполняемым вручную.
   */
  React.useEffect(() => {
    if (nsEdited) return;
    setNsText(zoneNameservers.join("\n"));
  }, [zoneNameservers, nsEdited]);

  // Провайдера ещё не знаем — это не «нет API»: пуш гасим (иначе десктоп
  // ответит `unknown provider`), но обвиняем в этом не регистратора, а
  // непрочитанный список аккаунтов. См. строки объяснений ниже.
  const providerKnown = registrarProvider != null && registrarProvider !== "";
  const nsApi = registrarSupportsNsApi(registrarProvider);

  return (
    <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10, marginTop: 18, borderTop: "1px solid #f3f4f6", paddingTop: 14 }}>
      <NsDelegationLine delegation={delegation} registrarProvider={registrarProvider} />
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <label htmlFor="ns-list" style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
            Nameservers (one per line)
          </label>
          {/* Подстановка одноразовая, поэтому вернуть NS зоны после правки
              нечем — отсюда явная ссылка. Неявное «очистка = сброс» на её
              месте воскрешало бы NS прямо под курсором при стирании
              backspace'ом. */}
          {/* Сравниваем НОРМАЛИЗОВАННЫЕ списки, а не текст посимвольно:
              лишний перевод строки в конце — не повод предлагать
              восстановление того, что и так уже в поле. */}
          {zoneNameservers.length > 0 && !sameNameservers(nameservers, zoneNameservers) ? (
            <button
              type="button"
              onClick={() => { setNsEdited(true); setNsText(zoneNameservers.join("\n")); }}
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
            {zonesError ? (
              <div style={{ fontSize: 12, color: WARN_TEXT }}>
                Could not prefill from Cloudflare: {clip(errorText(zonesError))}
              </div>
            ) : null}
            {/* Выключенная кнопка без объяснения — это загадка, а не запрет.
                Каждое условие в `disabled` ниже имеет свою строчку. */}
            {domain.registrar_id == null ? (
              <div style={{ fontSize: 12, color: WARN_TEXT }}>
                Assign a registrar account to this domain first — SDMP pushes NS through the registrar API.
              </div>
            ) : null}
            {domain.registrar_id != null && !providerKnown ? (
              <div style={{ fontSize: 12, color: WARN_TEXT }}>
                The registrar account of this domain is not loaded, so SDMP cannot tell whether it has a nameserver API.
              </div>
            ) : null}
            {domain.registrar_id != null && providerKnown && !nsApi ? (
              <div style={{ fontSize: 12, color: WARN_TEXT }}>
                SDMP has no nameserver API for «{registrarProvider}» — set the nameservers in the registrar's own panel.
              </div>
            ) : null}
            {domain.registrar_id != null && nameservers.length < MIN_NAMESERVERS ? (
              <div style={{ fontSize: 12, color: WARN_TEXT }}>
                Nothing to push: enter at least {MIN_NAMESERVERS} distinct nameservers above.
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "#92400e" }}>Read-only here. {NS_DESKTOP_NOTE}</div>
        )}
        {/* Отказ живёт здесь, а не баннером над всей карточкой: это отчёт
            кнопки, которая стоит следующей строкой, и над списком SSL/PHP он
            был бы новостью не по адресу. */}
        {setNsError ? (
          <div role="alert" style={{ fontSize: 12.5, color: "#991b1b", background: "#fee2e2", borderRadius: 8, padding: "8px 10px" }}>
            {setNsError}
          </div>
        ) : null}
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
              !nsApi ||
              nameservers.length < MIN_NAMESERVERS
            }
          >
            {setNs.isPending ? "Setting NS..." : "Set NS at registrar"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * Бейдж делегирования и одна фраза под ним.
 *
 * Состояний четыре, и четвёртое — «не знаем» — такое же полноправное, как
 * остальные три: NS зоны и NS у регистратора читаются вживую из двух чужих API,
 * и любое из чтений может не состояться. Без отдельного состояния незнание
 * пришлось бы округлить — в зелёное («расхождений не нашли») или в красное
 * («расходится»), — и оба округления врут. Причина рядом обязательна: серый
 * бейдж без неё сообщает только то, что мы чего-то не сделали.
 */
function NsDelegationLine({
  delegation,
  registrarProvider,
}: {
  delegation: NsDelegation;
  registrarProvider: string | null | undefined;
}) {
  const label =
    delegation.state === "delegated"
      ? "DELEGATED"
      : delegation.state === "pending"
        ? "PENDING"
        : delegation.state === "mismatch"
          ? "MISMATCH"
          : "UNKNOWN";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>Delegation:</b>
        <Badge variant={nsDelegationVariant(delegation.state)}>{label}</Badge>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {delegationText(delegation, registrarProvider)}
        </span>
      </div>
      {delegation.state === "mismatch" ? (
        // Оба набора рядом: «расходится» без того, что на что менять, — это
        // диагноз без содержания.
        <div style={{ fontSize: 12, color: WARN_TEXT, fontFamily: "monospace" }}>
          <div>at registrar: {delegation.actual.join(", ")}</div>
          <div>zone: {delegation.expected.join(", ")}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Фраза под бейджем: что именно известно и, для незнания, чего не хватило. */
function delegationText(d: NsDelegation, provider: string | null | undefined): string {
  if (d.state === "delegated") {
    return "The registrar points at this zone's nameservers and Cloudflare has confirmed it.";
  }
  if (d.state === "pending") {
    return `The registrar points at this zone's nameservers; Cloudflare has not confirmed the delegation yet (zone status: ${d.zoneStatus ?? "unknown"}).`;
  }
  if (d.state === "mismatch") {
    return "The registrar points somewhere else — push the zone's nameservers below.";
  }
  switch (d.reason) {
    case "no-zone":
      return "This domain is not bound to a live Cloudflare zone, so there is nothing to compare.";
    case "zone-nameservers-unknown":
      return "The nameservers of the Cloudflare zone are not known here.";
    case "no-registrar":
      return "No registrar account is assigned to this domain, so its real nameservers are unknown.";
    case "registrar-no-api":
      // Про то же ограничение сказано и янтарной строкой у кнопки, но там —
      // что делать (открыть панель регистратора), а здесь — почему сверки нет.
      return `The real nameservers cannot be read: «${provider}» has no nameserver API in SDMP.`;
    case "domain-not-at-registrar":
      return "This domain is not in the list of its registrar account — the wrong account may be assigned.";
    case "registrar-nameservers-unknown":
      return "The nameservers at the registrar are not known here.";
  }
}
