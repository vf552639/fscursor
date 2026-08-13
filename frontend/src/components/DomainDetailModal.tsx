import React, { useMemo } from "react";

import { Domain } from "../api/domains";
import { Zone, useCloudflareZones } from "../api/cloudflare";
import { useRegistrarAccounts, useRegistrarNameservers } from "../api/registrars";
import { NO_VALUE, expiryState, expiryTextColor, formatExpiry, formatExpiryDate } from "../lib/domainExpiry";
import { nsDelegation } from "../lib/nsDelegation";
import { registrarSupportsNsApi } from "../lib/registrarCaps";
import { isTauri } from "../lib/runtime";
import DomainCloudflareField from "./domains/DomainCloudflareField";
import DomainNsPanel from "./domains/DomainNsPanel";
import { Modal } from "./ui/Primitives";

/**
 * Строка карточки. Пустое значение рисуется прочерком, а не пустым местом:
 * незаполненное поле должно читаться как «не знаем», иначе строка «PHP:» без
 * ничего выглядит как обрезанная вёрстка, а не как ответ.
 *
 * Значения `null`, `undefined` и `""` уравнены намеренно: бэкенд отдаёт пустое
 * поле и так и эдак, и разница между «NULL» и «пустая строка» — наша, а не
 * пользователя.
 */
function Field({ k, v }: { k: string; v: React.ReactNode }) {
  const empty = v === null || v === undefined || v === "";
  return (
    <div>
      <b>{k}:</b> {empty ? NO_VALUE : v}
    </div>
  );
}

/**
 * Значение поля со сроком: дата и «сколько осталось» рядом, цветом состояния.
 * Дата без остатка требует считать в уме, остаток без даты нечем сверить с
 * письмом регистратора.
 *
 * Неизвестный срок отдаёт `null`, а не прочерк: его дорисует `Field`, и он
 * будет ТЕМ ЖЕ прочерком, что у остальных пустых полей карточки, а не вторым,
 * похожим. Сам символ приходит из `lib/domainExpiry` (`NO_VALUE`) — там он
 * объявлен ответом «мы не знаем», и три копии этого литерала по файлам уже
 * начинали жить своей жизнью.
 *
 * Дата — оттуда же (`formatExpiryDate`), а не из общего `fmtDate`: `expiry_date`
 * приходит датой без времени, и печатать её надо в UTC, иначе западнее UTC
 * карточка называет вчерашний день.
 */
function expiryValue(iso: string | null | undefined, now: number): React.ReactNode {
  const state = expiryState(iso, now);
  if (state === "unknown") return null;
  return (
    <span style={{ color: expiryTextColor(state) }}>
      {formatExpiryDate(iso)} · {formatExpiry(iso, now)}
    </span>
  );
}

/**
 * Карточка домена — один экран без вкладок.
 *
 * Вкладок нет по двум разным причинам. `db`, `ssl` и `nginx` (и кнопка «Create
 * Site») здесь невозможны: их действия бьют в роуты, которых на бэкенде не
 * существует, — вернуть их можно только новыми Tauri-командами с SSH-логикой,
 * это отдельная функция со своим планом.
 *
 * А аккаунт Cloudflare и nameservers — это один вопрос («куда домен делегирован
 * и почему не туда»), и разведённые по двум экранам они заставляют собирать
 * ответ из двух мест: зона резолвится на одном, а следствие — пустое поле NS и
 * погасшая кнопка — видно на другом.
 */
export default function DomainDetailModal({
  domain,
  onClose,
}: {
  domain: Domain;
  onClose: () => void;
}) {
  // Одно чтение часов на рендер карточки: два срока на одном экране обязаны
  // отвечать на «сейчас» одинаково.
  //
  // Именно `Date.now()`, а НЕ `useNow()` списка доменов, и это разные приёмы, а
  // не рассинхрон. Список перешёл на тик в минуту вынужденно: «сейчас» уезжает
  // там пропсом в каждую строку, и меняясь на каждый рендер, оно делает
  // `React.memo` строки бессмысленным по построению. У карточки строк нет —
  // есть два срока в одном поддереве, — и лишний таймер на открытую модалку
  // купил бы только стареющие сами по себе подписи, которых за время её жизни
  // никто не дождётся.
  const now = Date.now();

  /**
   * Зоны аккаунта Cloudflare — одно чтение на всю карточку, и от него зависят
   * три её ответа: nameservers зоны (подстановка в поле), статус зоны
   * (подтвердил ли Cloudflare делегирование) и поиск зоны по ИМЕНИ (дорезолв в
   * `DomainCloudflareField`). Хуки-`select`-ы поверх той же записи кэша
   * (`useZoneDetails`) отвечают на один вопрос каждый — три из них были бы
   * тремя именами для одного чтения; здесь нужен сам список.
   *
   * Цена — поход в Cloudflare на открытие карточки, и она осознанная: без NS
   * зоны и её статуса на этом экране нечего показывать вовсе. Запись кэша общая
   * со страницей Cloudflare и с прогоном привязки (`staleTime` 60с), так что
   * общее число походов от этого не растёт. Вне десктопа запрос не запускается
   * (`useCloudflareZones`): зон в базе нет, их читает `cf_list_zones`.
   */
  const zonesQ = useCloudflareZones(domain.cloudflare_account_id);
  const zones = zonesQ.data;
  /**
   * Зона домена: `null` — привязки нет или сохранённой зоны в аккаунте не
   * оказалось (обе новости значат «сверять не с чем и пушить нечего»),
   * `undefined` — зоны ещё не прочитаны.
   */
  const zone: Zone | null | undefined = useMemo(() => {
    if (!domain.cloudflare_account_id || !domain.cloudflare_zone_id) return null;
    if (!zones) return undefined;
    return zones.find((z) => z.id === domain.cloudflare_zone_id) ?? null;
  }, [zones, domain.cloudflare_account_id, domain.cloudflare_zone_id]);
  const zoneNameservers = useMemo(() => zone?.name_servers ?? [], [zone]);

  // Провайдер аккаунта регистратора: строка домена знает только его id, а
  // «умеет ли этот регистратор менять NS через API» — вопрос к провайдеру
  // (`lib/registrarCaps`, зеркало `make_service` в десктопе).
  const registrarAccountsQ = useRegistrarAccounts();
  const registrarProvider = registrarAccountsQ.data?.find((a) => a.id === domain.registrar_id)?.provider;

  /**
   * Настоящие NS домена — у регистратора, поимённым запросом про ЭТОТ домен
   * (`registrar_get_nameservers`), а не строкой из листинга аккаунта: листинг у
   * Namecheap nameservers не отдаёт вовсе, а у обоих провайдеров он
   * непагинирован — по нему «домена нет» и «страница кончилась» неразличимы.
   *
   * Читаем только когда ответ на что-то влияет: в десктопе (в вебе команда
   * обречена), у провайдера с NS-API (иначе `make_service` откажет ещё до сети)
   * и при известных NS зоны — без эталона сверка всё равно даст «не знаем», а
   * платить за неё пришлось бы запросом в чужой API на каждое открытие карточки.
   */
  const canReadRegistrarNs =
    isTauri() && registrarSupportsNsApi(registrarProvider) && zoneNameservers.length > 0;
  const registrarNsQ = useRegistrarNameservers(
    canReadRegistrarNs ? domain.registrar_id : null,
    domain.domain_name,
  );

  const delegation = nsDelegation({
    domainName: domain.domain_name,
    zone: zone
      ? { name: zone.name, nameservers: zone.name_servers ?? [], status: zone.status }
      : zone,
    registrarAccountId: domain.registrar_id,
    registrarProvider,
    registrarNameservers: registrarNsQ.data,
  });

  return (
    <Modal title={`Domain: ${domain.domain_name}`} onClose={onClose} width={760}>
      {/* Два столбца: слева — чем домен является (учётки, статус, сроки),
          справа — что развёрнуто на сервере. В один столбец полтора десятка
          строк уезжали бы под сгиб модалки.

          Server и Registrar остаются ЧИСЛАМИ — это id, и имён у карточки нет:
          за ними пришлось бы тянуть сюда список серверов или новый проп. Долг
          живой и ничей: id вместо имени читателю ничего не говорит. У
          Cloudflare такого долга нет — имя там нужно самой функции (выбрать
          аккаунт и дорезолвить зону), а не только читателю; у регистратора
          список уже читается ради провайдера, но подставить из него имя —
          отдельная правка, а не побочный эффект этой.

          Паролей здесь нет и быть не может: сервер их не знает (FTP и БД
          показываются один раз сразу после provision и нигде не хранятся).
          Пустых полей под них тоже нет — пустое поле «FTP password: —» обещало
          бы, что значение когда-нибудь появится. */}
      <div style={{ fontSize: 13, color: "#374151", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <Field k="Status" v={domain.status} />
          <Field k="Server" v={domain.server_id} />
          <Field k="Registrar" v={domain.registrar_id} />
          <DomainCloudflareField
            domain={domain}
            zone={zone}
            zones={zones}
            zonesError={zonesQ.error}
          />
          {/* Наша запись о последней попытке смены NS — не то же самое, что
              живая сверка делегирования ниже: одна говорит, что мы делали,
              вторая — что там на самом деле. */}
          <Field k="NS" v={`${domain.ns_status ?? "pending"} (${domain.ns_check_mode ?? "auto"})`} />
          {/* Срок — тем же модулем, что и колонка списка: два разных ответа
              про один домен на двух поверхностях хуже, чем отсутствие
              одного из них. */}
          <Field k="Expires" v={expiryValue(domain.expiry_date, now)} />
          <Field k="Last error" v={domain.last_provision_error} />
        </div>
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          <Field k="SSL" v={domain.ssl_status} />
          <Field k="SSL expires" v={expiryValue(domain.ssl_expires_at, now)} />
          <Field k="SSL issuer" v={domain.ssl_issuer} />
          <Field k="PHP" v={domain.php_version} />
          <Field k="Site user" v={domain.site_user} />
          <Field k="Site path" v={domain.site_path} />
          <Field k="FTP user" v={domain.ftp_user} />
          <Field k="DB name" v={domain.db_name} />
          <Field k="DB user" v={domain.db_user} />
        </div>
      </div>

      <DomainNsPanel
        domain={domain}
        zoneNameservers={zoneNameservers}
        zonesError={zonesQ.error}
        delegation={delegation}
        registrarProvider={registrarProvider}
        registrarNsError={registrarNsQ.error}
      />
    </Modal>
  );
}
