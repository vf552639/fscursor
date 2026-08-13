import React, { ChangeEvent, useEffect, useMemo, useRef } from "react";

import { CloudflareAccount, Zone, useCloudflareAccounts } from "../../api/cloudflare";
import { clip, errorText } from "../../api/cfAutoBind";
import { Domain, useUpdateDomain } from "../../api/domains";
import { resolveZoneByName } from "../../lib/cfZoneMatch";
import { isTauri } from "../../lib/runtime";
import { Sel } from "../ui/Primitives";

/** Приглушённый текст пояснения — тот же тон, что у прочих подписей карточки. */
const NOTE_TEXT = "#6b7280";
/** «Требует внимания, но не отказ» — тот же янтарь, что у подписей под кнопкой Set NS. */
const WARN_TEXT = "#b45309";
const ERROR_TEXT = "#991b1b";

export interface DomainCloudflareFieldProps {
  domain: Domain;
  /**
   * Зона домена: `undefined` — зоны аккаунта ещё не прочитаны, `null` — привязки
   * нет или сохранённой зоны в аккаунте не оказалось. Считает её карточка —
   * тот же объект уходит в сверку делегирования, и второй `find` по списку
   * означал бы два ответа на один вопрос.
   */
  zone: Zone | null | undefined;
  /** Все зоны выбранного аккаунта — по ним идёт дорезолв по имени. */
  zones: Zone[] | undefined;
  zonesError: unknown;
}

/**
 * Аккаунт Cloudflare домена: выбор по имени плюс дорезолв зоны.
 *
 * Именно селект с именами: `cloudflare_account_id` — число, которое читателю
 * карточки не говорит ничего, а сменить аккаунт домена больше негде (массовое
 * назначение из тулбара требует выделять строку в списке).
 *
 * Дорезолв зоны — вторая половина того же действия, и он не косметика:
 * `cloudflare_zone_id` это то, по чему карточка читает nameservers зоны и по
 * чему потом пушит их регистратору. Домен с аккаунтом, но без зоны (а такими
 * остаются все домены, привязанные не прогоном синхрона) выглядит настроенным,
 * а прописать ему NS нечем.
 *
 * Только десктоп: зон в базе нет вовсе, их вживую читает `cf_list_zones`. В вебе
 * селект работает (аккаунт — это метаданные, `PUT /domains/{id}`), а зона не
 * резолвится, и об этом сказано прямо, а не молчанием.
 */
export default function DomainCloudflareField({
  domain,
  zone,
  zones,
  zonesError,
}: DomainCloudflareFieldProps) {
  const accountsQ = useCloudflareAccounts();
  const accounts: CloudflareAccount[] = accountsQ.data ?? [];
  const update = useUpdateDomain(domain.id);
  const accountId = domain.cloudflare_account_id;
  const zoneId = domain.cloudflare_zone_id;

  /**
   * Что нашлось по имени домена в зонах ВЫБРАННОГО аккаунта. Считается только
   * когда зоны нет: у домена с сохранённой зоной перерешать нечего — там выбор
   * уже сделан, и переписывать его живым списком значило бы менять NS-путь за
   * спиной у пользователя.
   */
  const resolve = useMemo(
    () => (accountId != null && !zoneId && zones ? resolveZoneByName(domain.domain_name, zones) : null),
    [accountId, zoneId, zones, domain.domain_name],
  );

  /**
   * Ключ уже сделанной попытки записи. Без него отказ `PUT` (сеть, 500)
   * возвращал бы нас в то же состояние «аккаунт есть, зоны нет» — то есть
   * карточка долбила бы бэкенд в цикле, пока открыта.
   *
   * В ключе есть и аккаунт: смена аккаунта — это новое, разрешённое основание
   * попробовать снова.
   */
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (accountId == null || !resolve || resolve.outcome !== "matched") return;
    const key = `${accountId}:${resolve.zoneId}`;
    if (attempted.current === key) return;
    attempted.current = key;
    update.mutate({ cloudflare_zone_id: resolve.zoneId });
    // `update` в зависимостях нет намеренно: объект мутации новый на каждый
    // рендер, и от него эффект запускался бы на каждый рендер тоже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, resolve]);

  function pickAccount(value: string) {
    const next = value ? Number(value) : null;
    if (next === accountId) return;
    // Явный выбор снимает запрет на повторную попытку дорезолва: запрет стоит
    // против автоматического цикла, а не против человека, который вернулся к
    // прежнему аккаунту после неудачной записи.
    attempted.current = null;
    update.mutate({
      cloudflare_account_id: next,
      // Зона принадлежала СТАРОМУ аккаунту. Оставленная, она указывала бы на
      // то, чего в новом аккаунте нет, а пуш NS по ней увёл бы домен в чужую
      // зону — ровно та ошибка, от которой отказывается угадывать `cfZoneMatch`.
      cloudflare_zone_id: null,
    });
  }

  return (
    <div>
      <b>Cloudflare:</b>{" "}
      <Sel
        id="cf-account"
        aria-label="Cloudflare account"
        value={accountId == null ? "" : String(accountId)}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => pickAccount(e.target.value)}
        disabled={update.isPending}
        style={{ padding: "4px 8px", fontSize: 12.5 }}
      >
        <option value="">— No Cloudflare account —</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Sel>
      {update.isError ? (
        <div role="alert" style={{ fontSize: 12, color: ERROR_TEXT, marginTop: 4 }}>
          Could not save: {clip(errorText(update.error))}
        </div>
      ) : null}
      <ZoneNote
        accountId={accountId}
        zoneId={zoneId}
        zone={zone}
        zones={zones}
        zonesError={zonesError}
        resolve={resolve}
        domainName={domain.domain_name}
        accountName={accounts.find((a) => a.id === accountId)?.name}
        saveFailed={update.isError}
      />
    </div>
  );
}

/**
 * Строка про зону под селектом.
 *
 * Существует ради одного правила: **выбор аккаунта обязан получить ответ**.
 * Дорезолв — тихое фоновое действие, и когда он не срабатывает (зоны с таким
 * именем нет, их две, зоны не прочитались), молчание оставляет пользователя с
 * настроенной на вид карточкой, у которой не работает пуш NS. Каждый исход
 * назван, и у каждого своё продолжение: создать зону, убрать дубль, починить
 * токен, открыть десктоп.
 */
function ZoneNote({
  accountId,
  zoneId,
  zone,
  zones,
  zonesError,
  resolve,
  domainName,
  accountName,
  saveFailed,
}: {
  accountId: number | null;
  zoneId: string | null;
  zone: Zone | null | undefined;
  zones: Zone[] | undefined;
  zonesError: unknown;
  resolve: ReturnType<typeof resolveZoneByName> | null;
  domainName: string;
  accountName: string | undefined;
  saveFailed: boolean;
}) {
  const note = (color: string, text: React.ReactNode) => (
    <div style={{ fontSize: 12, color, marginTop: 3 }}>{text}</div>
  );
  // Аккаунта нет — говорить про зону нечего: сообщение «зона не найдена» под
  // пустым селектом читалось бы как поломка, а это просто непривязанный домен.
  if (accountId == null) return null;
  if (!isTauri()) {
    return note(NOTE_TEXT, "Zones are read by the desktop app, so the zone is not resolved here.");
  }
  if (zonesError) {
    // Текст самой ошибки печатается ОДИН раз — ниже, у поля nameservers
    // («Could not prefill from Cloudflare»): она там же и объясняет пустое
    // поле. Здесь — своё следствие того же отказа, без второй копии чужого
    // текста на одном экране.
    return note(WARN_TEXT, "The zone is not resolved: zones of this account could not be read.");
  }
  if (zoneId) {
    if (zone) return note(NOTE_TEXT, `Zone: ${zone.name} · ${zone.status ?? "unknown status"}`);
    // Зоны прочитаны, а сохранённой среди них нет: привязка указывает в
    // пустоту (обычно — зону удалили или id остался от другого аккаунта).
    if (zones) {
      return note(WARN_TEXT, `Saved zone ${zoneId} is not in this account — pick the account that owns it.`);
    }
    return note(NOTE_TEXT, "Reading the zone…");
  }
  if (!zones || !resolve) return note(NOTE_TEXT, "Looking for the zone…");
  if (resolve.outcome === "matched") {
    // Отказ записи уже назван красным над этой строкой — повторять его текст
    // здесь незачем, а вот «сохраняем…» после провала было бы враньём.
    return saveFailed
      ? note(WARN_TEXT, "Zone found, but it was not saved — see the error above.")
      : note(NOTE_TEXT, "Saving the zone…");
  }
  if (resolve.outcome === "ambiguous") {
    // Угадывать нельзя (то же правило, что в строке таблицы), но и молчать
    // нельзя: пользователь только что сделал явный выбор.
    return note(
      WARN_TEXT,
      `Zone not saved: ${accountName ?? "this account"} has ${resolve.zoneIds.length} zones named ${domainName} — remove the duplicate in Cloudflare.`,
    );
  }
  return note(
    WARN_TEXT,
    `No zone named ${domainName} in ${accountName ?? "this account"} — create it in Cloudflare or pick another account.`,
  );
}
