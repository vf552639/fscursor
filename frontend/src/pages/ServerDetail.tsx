import React, { useEffect, useState } from "react";
import { useMutationState } from "@tanstack/react-query";
import { StatCard, Card, CHd, CTi, CBo, Btn, StatusDot, Badge, fmtDate, pctColor, InfoRow, CopyBtn, Modal, Inp, Sel, RowActions, STALE_TEXT } from "../components/ui/Primitives";
import { STALE_SUFFIX, domainWord, formatAgoStale, formatUptime, mbToGb } from "../lib/format";
import { useServer, useServers, useDeleteServer, useTestSsh, useInstallFastPanel, installFastPanelKey, useUpdateServer, useRefreshMetrics, useServerListSites, ServerSite } from "../api/servers";
import { compareServerSites } from "../lib/serverSites";
import { providerError, providerOptions, providerPayload } from "../lib/providerInput";
import { ipError } from "../lib/ipInput";
import { fastpanelUrlError, fastpanelUserError } from "../lib/fastpanelInput";
import { isCheckStale, isMetricsStale, serverUiStatus, statusBadgeVariant } from "../lib/serverStatus";
import { OS_OPTIONS, osShortName, serverOsName } from "../lib/osName";
import { useDomains, useDeleteDomain, useUpdateDomain, useBulkAssignServer, useBulkCreateStructuredDomains, Domain } from "../api/domains";
import { RevealSecret } from "../components/RevealSecret";
import { OpenInDesktop } from "../components/OpenInDesktop";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { confirmAction } from "../lib/confirmDialog";
import { BLOB_KIND } from "../lib/secretBlob";
import { useSecretSave } from "../hooks/useSecretSave";
import type { InstallFastpanelResult } from "../lib/deepLink";

/** id `<datalist>` с подсказками провайдеров: на него ссылается `list` у поля. */
const PROVIDER_LIST_ID = "server-detail-provider-options";

// Пары `htmlFor`/`id` для полей новых форм: без них скринридер читает поле
// безымянным, а `<label>` по соседству сам по себе его не именует.
const IP_INPUT_ID = "server-detail-ip";
const OS_SELECT_ID = "server-detail-os";

/**
 * Адрес панели: свой, если известен, иначе собранный из адреса сервера. Одним
 * выражением на карточку доступа и на форму подключения — разъехавшись, они
 * показывали бы человеку один URL, а сохраняли другой.
 */
function fastpanelUrlOf(server: any): string {
  if (server?.fastpanel_url) return server.fastpanel_url;
  const ip = server?.ip_address ?? "";
  // IPv6 в URL — только в скобках (RFC 3986): без них «https://2a01:4f8::1:8888»
  // разбирается как хост «2a01» с портом «4f8», и открытая панель уедет не туда.
  // До появления правки адреса на этой странице IPv6 через UI сюда попасть не
  // мог — теперь может (`ipError(…, {ipv6:true})`).
  //
  // Признак — двоеточие, а не «не IPv4»: в колонке у старых серверов могло
  // осесть имя хоста, и его скобки как раз сломали бы.
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `https://${host}:8888`;
}

/** Строка колонки сверки: имя домена и, если есть, пояснение к его состоянию. */
interface CompareItem {
  name: string;
  /** Чем эта строка отличается от соседних (например, «сейчас prod-02»). */
  note?: string;
}

/**
 * Одна колонка сверки: заголовок с количеством и список имён (пусто → «—»).
 * `children` — лекарство группы (кнопка) под списком; у групп без лекарства его
 * нет, и колонка остаётся такой же, какой была.
 */
function CompareColumn({ title, items, tone, children }: { title: string; items: CompareItem[]; tone: string; children?: React.ReactNode }) {
  return (
    <div style={{display:"grid",gap:6,alignContent:"start"}}>
      <div style={{fontSize:12,fontWeight:700,color:tone,textTransform:"uppercase",letterSpacing:"0.4px"}}>{title} ({items.length})</div>
      {items.length === 0 ? (
        <div style={{fontSize:12.5,color:"#9ca3af"}}>—</div>
      ) : (
        items.map((it)=>(
          <div key={it.name} style={{fontSize:12.5,color:"#374151",wordBreak:"break-all"}}>
            {it.name}{it.note ? <span style={{color:"#9ca3af"}}> · {it.note}</span> : null}
          </div>
        ))
      )}
      {children}
    </div>
  );
}

/** Общий вид красной плашки внутри баннера — как у ошибок мутаций выше. */
const COMPARE_ALERT: React.CSSProperties = {marginTop:12, padding:"8px 12px", borderRadius:8, background:"#fee2e2", color:"#991b1b", fontSize:12.5};

/**
 * Сверка «сайты на сервере ↔ домены SDMP» плюс два лекарства к ней.
 *
 * Раскладка на четыре группы — чистая `compareServerSites` (`lib/serverSites`),
 * с тестами; здесь рендер и две мутации. Домены приходят ВСЕ, а не только
 * привязанные к этому серверу: иначе «SDMP о домене не знает» неотличимо от
 * «домен стоит на другой машине», а лечатся они по-разному.
 *
 * Мутации и список непрошедших имён баннеру ПЕРЕДАЮТСЯ, а не заводятся внутри,
 * и живут на странице. Причин две. Кнопка «Сверить домены» стоит выше баннера и
 * обязана гаснуть, пока идёт привязка, — а про мутации внутри баннера она знать
 * не может. И баннер нельзя размонтировать на новой сверке (раньше это делал
 * `key`): размонтирование посреди секундного POST уносило с собой и наблюдателя
 * мутации, и `skipped`, так что имена, которые сервер отказался заводить, не
 * показывались нигде — ровно тот провал, против которого `key` и вводился.
 * Отчёты о прошлом прогоне гасит эффект на странице.
 *
 * Своего гейта на десктоп у кнопок нет — и не надо: баннер показывается только
 * после удачной сверки, а сверка читает сайты по SSH и живёт только в десктопе.
 * Второй гейт поверх этого был бы мёртвой веткой, которую нечем проверить.
 */
function SiteCompareBanner({ sites, domains, serverId, serverName, servers, assignServer, createBound, skipped, onSkipped }: {
  sites: ServerSite[];
  /** ВСЕ домены пользователя (см. JSDoc выше), а не домены этого сервера. */
  domains: Domain[];
  serverId: number;
  serverName: string;
  /** Чтобы назвать сервер, на котором домен стоит сейчас, именем, а не числом. */
  servers: { id: number; name: string }[];
  assignServer: ReturnType<typeof useBulkAssignServer>;
  createBound: ReturnType<typeof useBulkCreateStructuredDomains>;
  /**
   * Имена, которые сервер отказался заводить: такой домен уже есть либо имя не
   * прошло проверку (`bulk_create_structured` кладёт в `skipped` оба случая, не
   * различая их, и чей это домен — не говорит). Это НЕ успех: привязку
   * пропущенным никто не поставил, а колонки после инвалидации выглядят как
   * «всё сделано». Молчать об этом нельзя (принцип №6) — потому поимённо.
   */
  skipped: string[];
  onSkipped: (names: string[]) => void;
}) {
  const cmp = compareServerSites(sites, domains, serverId);

  const serverNames = new Map(servers.map((x)=>[x.id, x.name]));
  const noteFor = (d: Domain) =>
    d.server_id == null ? "без сервера" : `сейчас ${serverNames.get(d.server_id) ?? `сервер #${d.server_id}`}`;

  // Те, кого привязка ПЕРЕВЕЗЁТ. Считаются отдельно от «ни на каком сервере»:
  // риск у них разный, и вопрос обязан это сказать (см. `bindExisting`).
  const moving = cmp.notBoundHere.filter((d)=>d.server_id != null);

  const bindExisting = async () => {
    const ids = cmp.notBoundHere.map((d)=>d.id);
    if (ids.length === 0) return;
    // Переезд назван своими словами, а не спрятан за общим «привязать»: смена
    // `server_id` на бэкенде сбрасывает снимок `fp_facts` — сайт за строкой в
    // базе не переезжает, и держать после переезда FTP-доступ с ПРЕЖНЕЙ машины
    // означало бы показывать пароль от чужого сервера как рабочий.
    const move = moving.length
      ? ` У ${moving.length} из них сейчас стоит другой сервер: привязка переедет, а прочитанные с прежней машины факты (FTP-доступ, пути, PHP) будут сброшены.`
      : "";
    if (!(await confirmAction(`Привязать ${ids.length} ${domainWord(ids.length)} к ${serverName}?${move}`))) return;
    // Гасится отчёт и СОСЕДНЕЙ кнопки: свой статус react-query сбросит сам на
    // старте мутации, а чужая красная плашка иначе переживёт этот прогон и
    // повиснет над колонками, перерисованными по свежим данным.
    onSkipped([]);
    createBound.reset();
    assignServer.mutate({ domain_ids: ids, server_id: serverId });
  };

  const createAndBind = async () => {
    const names = cmp.onlyOnServer.map((s)=>s.domain_name);
    if (names.length === 0) return;
    if (!(await confirmAction(`Завести в SDMP ${names.length} ${domainWord(names.length)} и привязать к ${serverName}?`))) return;
    // См. `bindExisting`: гасим и соседнюю ошибку тоже.
    onSkipped([]);
    assignServer.reset();
    createBound.mutate(
      { items: names.map((domain_name)=>({ domain_name, server_id: serverId })) },
      { onSuccess: (r)=>onSkipped(r.skipped) },
    );
  };

  return (
    <div style={{marginBottom:20, padding:"14px 18px", borderRadius:10, background:"#f9fafb", border:"1px solid #e5e7eb"}}>
      <div style={{fontSize:13,fontWeight:600,color:"#111",marginBottom:12}}>
        {/* Оба числа считаются ПО СВЕРКЕ, а не по длине входных списков: сырой
            счёт сайтов над колонками, где дубли схлопнуты, а мусорные имена
            выброшены, давал бы «на сервере 4» рядом с тремя строками — и куда
            делась четвёртая, экран не сказал бы нигде.

            «Привязано сюда», а не «в SDMP»: на вход идут все домены
            пользователя, и их общее число про этот сервер ничего не говорит. */}
        Сверка с сервером: на сервере {cmp.matched.length + cmp.notBoundHere.length + cmp.onlyOnServer.length}, привязано к {serverName} {cmp.matched.length + cmp.onlyInSdmp.length}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
        <CompareColumn title="Только на сервере" items={cmp.onlyOnServer.map((s)=>({name:s.domain_name}))} tone="#b45309">
          {cmp.onlyOnServer.length > 0 && (
            <Btn size="sm" variant="secondary" onClick={createAndBind} disabled={createBound.isPending}>
              {createBound.isPending ? "Завожу…" : "Завести и привязать"}
            </Btn>
          )}
        </CompareColumn>
        <CompareColumn title="Не привязано сюда" items={cmp.notBoundHere.map((d)=>({name:d.domain_name, note:noteFor(d)}))} tone="#c2410c">
          {cmp.notBoundHere.length > 0 && (
            <Btn size="sm" variant="secondary" onClick={bindExisting} disabled={assignServer.isPending}>
              {assignServer.isPending ? "Привязываю…" : "Привязать к этому серверу"}
            </Btn>
          )}
        </CompareColumn>
        <CompareColumn title="Совпало" items={cmp.matched.map((m)=>({name:m.domain.domain_name}))} tone="#166534" />
        <CompareColumn title="Только в SDMP" items={cmp.onlyInSdmp.map((d)=>({name:d.domain_name}))} tone="#6b7280" />
      </div>
      {/* Отказ мутации показывается здесь же, у кнопки, которая его вызвала: без
          этого неудачная привязка выглядела бы как удачная — колонки просто
          остались бы прежними, и человек нажал бы ещё раз. */}
      {assignServer.isError && (
        <div role="alert" style={COMPARE_ALERT}>
          Не удалось привязать домены: {(assignServer.error as any)?.message || "request error"}
        </div>
      )}
      {createBound.isError && (
        <div role="alert" style={COMPARE_ALERT}>
          Не удалось завести домены: {(createBound.error as any)?.message || "request error"}
        </div>
      )}
      {skipped.length > 0 && (
        <div role="alert" style={COMPARE_ALERT}>
          Не заведены и не привязаны — такой домен уже есть в SDMP либо имя не прошло проверку: {skipped.join(", ")}
        </div>
      )}
    </div>
  );
}

export default function ServerDetail({server, onBack, onNav, onFastpanelCreds}: {
  server?: any,
  onBack: (p: string)=>void,
  onNav?: (p: string, ctx?: any)=>void,
  /**
   * Куда отдать креды панели после установки. Показывает их единственная
   * модалка показа-один-раз, которой владеет DesktopWorkspace: тот же экран уже
   * получает креды из deep link, и второго быть не должно.
   *
   * Обязательный, хотя формально мог бы быть опциональным: пароль панели
   * существует только в ответе команды, и без этого пропа он после 30-40 минут
   * установки исчезал бы молча. Такую потерю компилятор умеет делать
   * невыразимой — комментарий умеет только объяснить её задним числом.
   */
  onFastpanelCreds: (creds: InstallFastpanelResult)=>void,
}){
  const [tab,setTab]=useState("overview");
  const [domSearch,setDS]=useState("");
  const [showPass,setShowPass]=useState(false);
  
  const [showSshModal, setShowSshModal] = useState(false);
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  // Плейнтекст пароля держит хук: эта страница смонтирована целиком, модалку
  // она только прячет, — своё `useState` пережило бы закрытие формы и лежало бы
  // в памяти до ухода со страницы.
  const sshPassword = useSecretSave("SSH password");
  const [editingDomain, setEditingDomain] = useState<any | null>(null);

  // Переименование. Как и провайдер ниже — обычное поле сущности, не секрет.
  const [showNameModal, setShowNameModal] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);

  // Подключение уже стоящей панели. Плейнтекст пароля держит хук — по той же
  // причине, что и у SSH-формы выше: страница смонтирована целиком, модалку она
  // только прячет.
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [fpUrl, setFpUrl] = useState("");
  const [fpLogin, setFpLogin] = useState("fastuser");
  const [fpConnectErr, setFpConnectErr] = useState<Record<string, string>>({});
  const fpPassword = useSecretSave("FastPanel password");

  // Правка провайдера. Обычным `useState`, а не `useSecretSave`: провайдер —
  // не секрет, он едет полем сущности и хранится плейнтекстом в колонке.
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [provider, setProvider] = useState("");
  const [providerErr, setProviderErr] = useState<string | null>(null);

  // Правка адреса. Как имя и провайдер — обычное поле сущности, не секрет.
  const [showIpModal, setShowIpModal] = useState(false);
  const [ipValue, setIpValue] = useState("");
  const [ipErr, setIpErr] = useState<string | null>(null);

  // Правка ОС. Значение — из закрытого списка `OS_OPTIONS`, поэтому своего
  // состояния под ошибку ВВОДА не нужно; `osErr` держит только отказ сервера.
  //
  // `null` — законное состояние: у сервера может стоять семейство, которого в
  // списке нет (см. `openOsModal`). Именно поэтому не `OS_OPTIONS[0]`: значение
  // по умолчанию тут означало бы «человек выбрал Debian», а он ничего не
  // выбирал.
  const [showOsModal, setShowOsModal] = useState(false);
  const [osValue, setOsValue] = useState<(typeof OS_OPTIONS)[number] | null>(null);
  const [osErr, setOsErr] = useState<string | null>(null);

  // Queries
  const { data: s } = useServer(server?.id);
  // Подсказки провайдеров берём из общего списка серверов — того же запроса,
  // что уже загрузила страница Servers (ключ ["servers"]), так что сюда приходят
  // из кэша. Отдельного эндпоинта «список провайдеров» нет намеренно: второй
  // источник тех же значений умел бы разойтись с первым.
  const { data: serversList } = useServers();
  const { data: domainsData } = useDomains({ server_id: server?.id });
  const domains: Domain[] = domainsData ?? [];
  // Второй список — ВСЕ домены пользователя, и только для сверки. Первый
  // (отфильтрованный сервером) отсюда не выводится и им не заменяется: таблица
  // ниже показывает домены именно этого сервера, а сверке нужны все, иначе
  // «SDMP о домене не знает» неотличимо от «домен стоит на другой машине». Два
  // запроса, а не один с фильтром на клиенте: серверный фильтр — это то, что
  // таблица показывает, и повторять его вручную значит завести второе правило
  // «чьи домены считать серверными».
  //
  // Держим ЗАПРОС, а не `data ?? []`: прочерк на месте непрочитанного списка
  // сверка читает как знание. При отказе `GET /domains` баннер уверенно писал
  // «привязано к prod-01 0», складывал ВСЕ сайты сервера в «только на сервере»
  // и предлагал завести заново домены, которые уже привязаны сюда, — от порчи
  // данных спасал только UNIQUE на бэкенде, а человек получал красную плашку
  // про домены, с которыми всё в порядке.
  const allDomainsQ = useDomains();
  
  // FastPanel setup
  const isFPInstalled = s?.fastpanel_status === "installed";
  // Легаси-статусы времён серверной установки через Celery. Сейчас статус
  // двигает только write-back десктопа, и то сразу в `installed`, так что эти
  // значения означают «прошлая попытка оборвалась». Показываем их как контекст,
  // но кнопку НЕ прячем: иначе сервер, застрявший в "installing", остаётся без
  // единственного способа поставить панель.
  const isFPStuck = s?.fastpanel_status === "pending" || s?.fastpanel_status === "updating" || s?.fastpanel_status === "installing";

  // Mutations
  const delSrv = useDeleteServer();
  // Сущность, а не id: ссылку на блоб с паролем знает только она (`SshTarget`).
  const testSsh = useTestSsh(s);
  // Проп передаём напрямую, без обёртки. Опции мутации это не стабилизирует —
  // `mutationFn` всё равно инлайновое замыкание, а ключ всё равно новый массив,
  // так что shallowEqualObjects ложна на каждом рендере (безвредно: setOptions
  // не роняет hashKey и не перерендеривает). Стабильна становится идентичность
  // коллбэка, который захватывает замыкание, — а вот это и важно.
  const installFp = useInstallFastPanel(server?.id || 0, onFastpanelCreds);
  // Состояние установки читаем из MutationCache, а не из локального observer:
  // установка идёт 30-40 минут и переживает уход со страницы, а observer при
  // размонтировании теряет с ней связь. Без этого после возврата на страницу
  // кнопка снова активна (второй `install_fastpanel` поверх первого), нет
  // признака идущей установки и не видно ошибки, случившейся в отсутствие
  // страницы.
  //
  // Тонкость на будущее: `useMutationState` пересчитывает результат только
  // внутри подписки на MutationCache, а новые options попадают в его
  // `optionsRef` через `useEffect`. Пока смена сервера всегда идёт через
  // размонтирование (в `server-detail` попадают с другой страницы, а
  // DesktopWorkspace рендерит его условно), это неважно; но переход
  // сервер→сервер без размонтирования начнёт показывать состояние предыдущего
  // сервера до ближайшего события кэша. У самого observer'а мутации такой
  // проблемы нет — он сбрасывается на другом hashKey.
  const fpStates = useMutationState({
    filters: { mutationKey: installFastPanelKey(server?.id || 0) },
    select: (m) => m.state,
  });
  // Именно ПОСЛЕДНЯЯ попытка, а не «последняя ошибка в истории»: провалившаяся
  // мутация живёт в кэше ещё gcTime после того, как её сменила успешная, и
  // поиск по всей истории вытаскивал бы получасовой давности ошибку из-под
  // кнопки уже установленной панели. Особенно на пути `writeback_failed`, где
  // карточка не исчезает: сервер так и не узнал, что панель установлена.
  // Последняя запись = последняя попытка: getAll() отдаёт Set в порядке
  // создания, findAll этот порядок сохраняет.
  const fpLast = fpStates[fpStates.length - 1];
  const fpRunning = fpLast?.status === "pending";
  const fpError = fpLast?.status === "error" ? fpLast.error : null;
  // Сущность, а не id: метрики снимает десктоп по SSH, и ссылку на блоб с
  // паролем знает только она (см. `useTestSsh`).
  const refreshMetrics = useRefreshMetrics(s);
  // Сверка «сайты на сервере ↔ домены SDMP». Пришла на замену мёртвому
  // «Sync Domains» (роут `POST /servers/{id}/sync-domains` удалён переездом на
  // zero-knowledge — был гарантированный 404). Читает по SSH и показывает
  // расхождение; ничего на сервере не меняет.
  const listSites = useServerListSites(server?.id || 0);
  // Лекарства сверки живут здесь, а не в баннере: кнопка сверки обязана гаснуть,
  // пока они идут, а баннер не должен размонтироваться посреди их POST (см.
  // JSDoc `SiteCompareBanner`).
  const assignServer = useBulkAssignServer();
  const createBound = useBulkCreateStructuredDomains();
  const [compareSkipped, setCompareSkipped] = useState<string[]>([]);
  // Новая сверка — новые данные, значит прошлые отчёты о лечении к ним не
  // относятся. Раньше это делал `key` на баннере, но размонтирование уносило и
  // ещё не приехавший ответ.
  //
  // Зависимость ровно одна — время последнего запуска сверки. `reset` у мутации
  // стабилен (`MutationObserver` привязывает его в конструкторе), но окажись он
  // новым на каждом рендере — эффект гасил бы ошибку сразу после её появления,
  // и плашку никто бы не увидел. Такую цену за формальную полноту списка
  // зависимостей платить нечем.
  const compareRunAt = listSites.submittedAt;
  useEffect(() => {
    setCompareSkipped([]);
    assignServer.reset();
    createBound.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareRunAt]);
  const updateServer = useUpdateServer(server?.id || 0);
  const deleteDomain = useDeleteDomain();
  const updateDomain = useUpdateDomain(editingDomain?.id || 0);

  // Открываем модалку только отсюда: поля надо взять у сервера, иначе правка
  // SSH-пароля заодно молча переписала бы пользователя на "root" и порт на 22.
  const openSshModal = () => {
    setSshUser(s?.ssh_user || "root");
    setSshPort(s?.ssh_port || 22);
    sshPassword.reset();
    setShowSshModal(true);
  };

  // Закрытие формы — единственное место, где набранный пароль надо забыть:
  // ✕ и клик по оверлею оба зовут `onClose` модалки, и без этого плейнтекст
  // пережил бы закрытие (страница-то смонтирована).
  const closeSshModal = () => {
    sshPassword.reset();
    setShowSshModal(false);
  };

  const handleSaveSsh = async () => {
    const ok = await sshPassword.save({
      blobKind: BLOB_KIND.serverSshPassword,
      // Это ПРАВКА: у сервера уже может быть блоб, и переписать надо именно
      // его. Новый id оставил бы сущность указывать на прежний пароль —
      // «сохранено», а по SSH ходит старый секрет. Версии блоба ведёт сервер
      // внутри одного id.
      existingBlobId: s?.ssh_password_blob_id ?? null,
      // `await` без возврата значения: `persist` объявлен `Promise<void>`,
      // чтобы в него нельзя было вложить второй `save` (см. его JSDoc).
      persist: async (blobId) => {
        await updateServer.mutateAsync({
          ssh_user: sshUser,
          ssh_password_blob_id: blobId,
          ssh_port: sshPort
        });
      },
    });
    if (ok) setShowSshModal(false);
  };

  const openConnectModal = () => {
    // Адрес панели собирается из `ip_address` самого сервера: сюда попадают
    // только с уже заведённого сервера, и IP известен. Пустое поле заставляло
    // бы набирать руками то, что программа и так знает.
    //
    // Исключение — IPv6: `fastpanelUrlError` (и парные ему проверки на бэкенде и
    // в десктопе) принимают только «хост:порт» без скобок, так что собранный
    // адрес форма забраковала бы сама — предзаполнять поле заведомо невалидным
    // значением хуже, чем оставить его пустым с плейсхолдером. Подключить панель
    // по IPv6 сегодня нельзя вовсе; чинится это расширением трёх парных
    // регулярок (`lib/fastpanelInput`, `backend/app/core/validators.py`,
    // `host_port_regex()` в десктопе) на bracketed-IPv6 — работа за границами
    // этой задачи, записана в долг.
    setFpUrl(s?.ip_address?.includes(":") ? "" : fastpanelUrlOf(s));
    setFpLogin(s?.fastpanel_user || "fastuser");
    fpPassword.reset();
    setFpConnectErr({});
    setShowConnectModal(true);
  };

  // Как и у SSH-формы: ✕, клик по оверлею и Cancel зовут именно это, чтобы
  // плейнтекст не пережил закрытие формы — страница-то смонтирована, и своё
  // состояние лежало бы в памяти до ухода с неё.
  //
  // Тестом этот сброс НЕ стережётся, и это надо знать: `openConnectModal` зовёт
  // `reset()` тоже, поэтому пустое поле в переоткрытой форме обеспечивает
  // открытие, а не закрытие, — снимите `reset()` отсюда, и все тесты останутся
  // зелёными. Инвариант тут свой (плейнтекст в памяти закрытой формы), и через
  // DOM он не наблюдаем; двойной сброс — осознанная страховка, а не дубль.
  const closeConnectModal = () => {
    fpPassword.reset();
    setShowConnectModal(false);
  };

  const handleSaveConnect = async () => {
    // Проверка ДО `save()`, как и в «Add Server»: порядок «блоб → сущность», и
    // отказ после записи оставил бы в хранилище пароль от панели, которую так и
    // не подключили. Собираются ВСЕ промахи разом — иначе человек чинил бы URL,
    // чтобы следующим кликом узнать про пустой пароль.
    const errs: Record<string, string> = {};
    const urlErr = fastpanelUrlError(fpUrl);
    if (urlErr) errs.url = urlErr;
    const loginErr = fastpanelUserError(fpLogin);
    if (loginErr) errs.login = loginErr;
    // Просто «Password», без имени панели: форма называется «Connect Existing
    // Fastpanel», и уточнение в тексте ошибки отвечало бы на вопрос, которого
    // никто не задавал. Шаблон «… is required» — общий для обязательных полей
    // здесь и в «Add Server»: одно требование не должно объясняться двумя
    // разными фразами.
    if (!fpPassword.value) errs.password = "Password is required";
    setFpConnectErr(errs);
    if (Object.keys(errs).length > 0) return;

    const ok = await fpPassword.save({
      blobKind: BLOB_KIND.serverFastpanelPassword,
      // Как и у SSH: сервер мог уже носить пароль панели (например, после
      // оборвавшейся попытки), и переписать надо именно его блоб — новый id
      // оставил бы сущность указывать на прежний секрет.
      existingBlobId: s?.fastpanel_password_blob_id ?? null,
      persist: async (blobId) => {
        // PUT, а не POST: сервер уже заведён — «Add Server» про панель не знает
        // вовсе. `fastpanel_status` обязателен — без него блок установки так и
        // остался бы поверх работающей панели.
        await updateServer.mutateAsync({
          fastpanel_user: fpLogin,
          fastpanel_password_blob_id: blobId,
          // Обрезанное — ровно то, что проверил `fastpanelUrlError`.
          fastpanel_url: fpUrl.trim(),
          fastpanel_status: "installed",
        });
      },
    });
    if (ok) setShowConnectModal(false);
  };

  // Поле заполняется ТЕКУЩИМ именем — по той же причине, что и в SSH-форме:
  // пустая форма правки читается как «стереть» тем, кто открыл её посмотреть.
  const openNameModal = () => {
    setNameValue(s?.name || "");
    setNameErr(null);
    setShowNameModal(true);
  };

  const handleSaveName = () => {
    // Проверка до отправки, как и в «Add Server»: пустое имя бэкенд отвергает
    // 422-й строкой про схему, а не фразой про поле. Формулировка та же, что
    // там, — одно требование не должно объясняться двумя разными фразами.
    if (!nameValue.trim()) {
      setNameErr("Server name is required");
      return;
    }
    // Ровно одно поле в теле — тот же довод, что у провайдера ниже: PUT,
    // собранный из всего состояния страницы, переписал бы заодно ssh_user и
    // ssh_port дефолтами SSH-формы.
    //
    // Отказ — в СВОЁ состояние, а не через `updateServer.isError`: тем же хуком
    // сохраняются и SSH-доступ, и провайдер, и чужая провалившаяся мутация
    // висела бы в `isError` до следующей — открытая потом форма имени встречала
    // бы пользователя красным баннером про чужую ошибку.
    updateServer.mutate(
      // Обрезанным: «web-01 » и «web-01» стояли бы в списке серверов двумя
      // строками, различить которые глазом нечем.
      { name: nameValue.trim() },
      {
        onSuccess: () => setShowNameModal(false),
        onError: (e: any) => setNameErr(e?.message || "Не удалось сохранить"),
      },
    );
  };

  // Как и у SSH-формы: поле заполняется ТЕКУЩИМ значением сервера. Пустая форма
  // правки читается как «стереть» тем, кто открыл её просто посмотреть.
  const openProviderModal = () => {
    setProvider(s?.provider || "");
    setProviderErr(null);
    setShowProviderModal(true);
  };

  const handleSaveProvider = () => {
    // Проверка до отправки — по той же причине, что и в форме добавления:
    // 422 от схемы приезжает сюда строкой вида «provider: String should have at
    // most 64 characters», а не фразой про поле.
    const err = providerError(provider);
    if (err) {
      setProviderErr(err);
      return;
    }
    // Ровно одно поле в теле: PUT, собранный из всего состояния страницы,
    // переписал бы заодно ssh_user и ssh_port дефолтами формы.
    //
    // Отказ кладём в СВОЁ состояние, а не читаем `updateServer.isError`: тот же
    // хук сохраняет и SSH-доступ, и его провалившаяся мутация висела бы в
    // `isError` до следующей — открытая потом форма провайдера встречала бы
    // пользователя красным баннером про чужую ошибку.
    updateServer.mutate(
      { provider: providerPayload(provider) },
      {
        onSuccess: () => setShowProviderModal(false),
        onError: (e: any) => setProviderErr(e?.message || "Не удалось сохранить"),
      },
    );
  };

  // Как и у формы имени: поле заполняется ТЕКУЩИМ адресом. Пустая форма правки
  // читается как «стереть» тем, кто открыл её просто посмотреть.
  const openIpModal = () => {
    setIpValue(s?.ip_address || "");
    setIpErr(null);
    setShowIpModal(true);
  };

  const handleSaveIp = () => {
    // Проверка до отправки тем же модулем, что и в «Add Server»: формат адреса
    // бэкенд не проверяет вовсе (см. JSDoc `lib/ipInput`), так что принятый
    // здесь мусор дальше некому остановить — он уедет в SSH-коннект и в адрес
    // панели. `ipv6: true` — разница именно этой формы: у уже заведённого
    // сервера адрес мог смениться на IPv6, и отвергать настоящий адрес машины
    // форма правки не вправе.
    const trimmed = ipValue.trim();
    const err = ipError(trimmed, { ipv6: true });
    if (err) {
      setIpErr(err);
      return;
    }
    // Ровно одно поле в теле и своё состояние под ошибку — тот же довод, что у
    // имени и провайдера выше: общий PUT переписал бы ssh_user/ssh_port
    // дефолтами SSH-формы, а общий `updateServer.isError` показал бы здесь
    // чужую провалившуюся правку.
    updateServer.mutate(
      { ip_address: trimmed },
      {
        onSuccess: () => setShowIpModal(false),
        onError: (e: any) => setIpErr(e?.message || "Не удалось сохранить"),
      },
    );
  };

  const openOsModal = () => {
    // Через `serverOsName`, а не сырым `s.os`: у старых серверов в этой колонке
    // лежит строка с версией и архитектурой («Ubuntu 22.04 LTS (x86_64)»), а
    // `<select>` со значением вне своих опций показал бы первый пункт — человек
    // увидел бы «Debian» там, где стоит Ubuntu, и сохранил бы это одним кликом.
    // `serverOsName` приводит такую строку к «Ubuntu» и заодно даёт то самое
    // правило приоритета (ручной `os` перекрывает автоопределённый `os_pretty`),
    // которым карточка уже подписана.
    const short = serverOsName(s || {});
    const known = OS_OPTIONS.find((o) => o === short);
    // Остаётся случай, которого закрытый список выразить не умеет вовсе:
    // семейства вне пяти пунктов (Red Hat, Fedora, openSUSE — их приносит
    // автоопределение по SSH, см. `FAMILY_NEEDLES`). Тогда `null`, и селект
    // показывает НАСТОЯЩЕЕ имя отдельным нерабочим пунктом — подставленный
    // «Debian» противоречил бы строке карточки, из которой форму и открыли, а
    // цена случайного «Save» тут не косметическая: колонку `os` читает
    // `update_command` в десктопе (`provision.rs`) и по ней выбирает apt или
    // yum, то есть один клик ломал бы получасовую установку FastPanel. Вернуть
    // прежнее значение после этого нечем: `os` перекрывает `os_pretty` в
    // `serverOsName`, так что и бейдж остался бы врать.
    setOsValue(known ?? null);
    setOsErr(null);
    setShowOsModal(true);
  };

  const handleSaveOs = () => {
    // Не выбрано ничего — сохранять нечего: кнопка в этом состоянии мертва, и
    // guard тут для полноты (клавиатура, повторный клик до перерисовки).
    if (!osValue) return;
    // Проверки ввода нет намеренно: значение приходит из `<select>` по закрытому
    // списку `OS_OPTIONS`, свободного ввода в поле не бывает.
    //
    // Одно поле в теле и своя ошибка — по тем же причинам, что у соседей выше.
    updateServer.mutate(
      { os: osValue },
      {
        onSuccess: () => setShowOsModal(false),
        onError: (e: any) => setOsErr(e?.message || "Не удалось сохранить"),
      },
    );
  };

  const handleDelete = async () => {
    if (await confirmAction("Delete server?")) {
      delSrv.mutate(s!, { onSuccess: () => onBack("servers") });
    }
  };

  if (!s) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading server details...</div>;

  // Одно чтение часов на рендер — см. тот же приём в списке серверов и на
  // дашборде: отдельный `Date.now()` в каждой функции дал бы три разных
  // «сейчас» про один и тот же сервер.
  const now = Date.now();
  // Лестница статусов — общая с дашбордом и списком (`lib/serverStatus`): три
  // экрана рисуют один и тот же сигнал, и переписанная на каждом заново она уже
  // разъезжалась.
  const uiStatus = serverUiStatus(s, now);
  const checkStale = isCheckStale(s.last_check_at, now);
  // Приоритет ручного выбора над автоопределением — общее правило, см.
  // JSDoc `serverOsName` в `lib/osName`.
  const osLabel = serverOsName(s);
  // Что ответила по SSH сама машина. Показывается только в форме правки ОС и
  // только при расхождении с тем, что в этой форме выбрано: с тех пор как ручной
  // `os` перекрывает `os_pretty` везде, автоопределённое значение не видно ни на
  // одном экране — а состояние «человек выбрал CentOS, машина отвечает Ubuntu»
  // это ровно то, в котором `update_command` берёт yum вместо apt и получасовая
  // установка FastPanel ломается на первом шаге.
  //
  // Сравнивается с ПОКАЗАННЫМ в форме (`osValue ?? osLabel`), а не с `osValue`:
  // у семейства вне списка `osValue` пуст, и селект показывает `osLabel` — там,
  // где это то же самое имя, подсказка повторяла бы соседнюю строку слово в
  // слово.
  const osDetected = osShortName(s.os_pretty);
  const osMismatch = osDetected && osDetected !== (osValue ?? osLabel) ? osDetected : null;
  const providers = providerOptions(serversList?.items || []);
  // Снимок есть ровно тогда, когда есть его отметка времени: и десктопный
  // сборщик (`apply_metrics`), и удалённый серверный до него ставили её всегда,
  // так что «цифры без отметки» — не состояние, а невозможность. Отдельной
  // константой, а не выражением по месту: `string | null` так сужается ветвлением
  // и не требует приведения типа в каждой из трёх точек показа.
  const metricsAt = s.metrics_collected_at;
  const metricsStale = isMetricsStale(metricsAt, now);

  const fp = {
    url: fastpanelUrlOf(s),
    login: s.fastpanel_user || "fastuser",
    password: "encrypted (hidden)", // Actual password not sent via API 
    version: s.fastpanel_version ?? "—",
    port: s.fastpanel_port ?? 8888
  };
  
  const filtered = domains.filter((d: any)=>d.domain_name.toLowerCase().includes(domSearch.toLowerCase()));
  
  // Только доли, которые действительно измерены: рядов наблюдений (`genBars`)
  // у карточек больше нет — историю метрик мы не храним, и пятнадцать случайных
  // столбиков вокруг одного значения были чистой выдумкой.
  //
  // `undefined`, а не `0`: `StatCard` при `undefined` полосу не рисует вовсе, а
  // при нуле рисует пустой жёлоб — под значением «—» он читается как «CPU 0%»,
  // то есть как измеренная нулевая загрузка. У RAM и SSD ниже ровно то же
  // правило, и CPU был единственным, кто из него выпадал.
  const cpuPct = s.cpu_usage_pct ?? undefined;
  const ramPct = s.ram_used_mb != null && s.ram_total_mb ? Math.round((s.ram_used_mb / s.ram_total_mb) * 100) : undefined;
  const diskPct = s.disk_used_gb != null && s.disk_total_gb ? Math.round((s.disk_used_gb / s.disk_total_gb) * 100) : undefined;

  /**
   * Показание карточки. Протухшее красится тем же цветом, что в списке серверов
   * и на дашборде, а не приглушается прозрачностью всего блока: `opacity: 0.6`
   * была третьим механизмом для одного сигнала и утаскивала заодно серые
   * подписи («of 4 GB») примерно к 2.6:1 — то есть пряталось и то, что должно
   * читаться. Прочерк остаётся прочерком: «показания нет» протухнуть не может.
   */
  const reading = (text: string | null) =>
    text === null ? "—" : <span style={metricsStale ? {color: STALE_TEXT} : undefined}>{text}</span>;

  return <>
    <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#9ca3af",marginBottom:20}}>
      <span onClick={()=>onBack("servers")} style={{cursor:"pointer"}}>Servers</span><span>/</span>
      <span style={{color:"#111",fontWeight:500}}>{s.name}</span>
    </div>
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:24}}>
      <div>
        {/* Карандаш у самого имени: до него имя задавалось один раз в «Add
            Server» и опечатка оставалась с сервером навсегда. Правка — мутация,
            а значит только десктоп (заметка для веба — ниже, отдельной строкой).
            Не OpenInDesktop: хоста `server-rename` в parseDeepLinkAction нет,
            ссылка вела бы в {handled:false} и только тостила бы сама себя.

            `RowActions`, а не `Btn`: это иконочная кнопка, а `RowActions` —
            единственный примитив, который сам ставит глифу `title`/`aria-label`.
            Голый «✎» без имени не читается ни скринридером, ни курсором — и
            выпадал бы из ряда: все прочие карандаши в проекте несут слово. */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}><StatusDot status={uiStatus}/><h1 style={{fontSize:22,fontWeight:700,color:"#111"}}>{s.name}</h1>{isTauri() && (
          <RowActions actions={[{ icon: "✎", title: "Rename server", onClick: openNameModal }]}/>
        )}{osLabel ? <Badge variant="gray">{osLabel}</Badge> : null}{isFPInstalled&&<Badge variant="blue">FASTPANEL</Badge>}</div>
        {/* Пометка стоит вплотную к самой цифре: аптайм здесь — часть того же
            снимка, и «3d 0h» трёхмесячной давности без неё читается как «сервер
            работает три дня» прямо сейчас. */}
        <div style={{fontSize:13,color:"#6b7280"}}>{s.ip_address} · <span style={metricsStale?{color:STALE_TEXT}:undefined}>Uptime: {formatUptime(s.uptime_seconds)}{metricsStale?STALE_SUFFIX:""}</span> · Added {fmtDate(s.created_at)}</div>
        {/* Объяснение вместо карандаша — своей строкой, а не на месте кнопки в
            строке заголовка: заметка это блок с рамкой и padding'ом, и внутри
            flex-строки «точка — имя — бейджи» она распирала бы её на ширину
            целого предложения, утаскивая бейджи ОС и FASTPANEL вправо. `what`
            тот же, что у правки провайдера: запрет один, и объяснение у него
            должно быть одно. */}
        {!isTauri() && (
          <div style={{marginTop:8}}><DesktopOnlyNote what="Editing servers" /></div>
        )}
        <button onClick={() => onNav?.("domains", { serverId: s.id })} style={{marginTop:8,border:"none",background:"transparent",padding:0,color:"#2563eb",fontSize:12.5,cursor:"pointer"}}>See all server domains in Domains →</button>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {/* Не OpenInDesktop: хоста `ssh-test` в parseDeepLinkAction нет, ссылка
            вела бы в {handled:false} и только тостила бы сама себя. Та же
            развилка и по той же причине, что у «Изменить SSH» ниже. */}
        {s.has_ssh ? (
          isTauri() ? (
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => testSsh.mutate()}
              disabled={testSsh.isPending}
            >
              {testSsh.isPending ? "Testing..." : "SSH Test"}
            </Btn>
          ) : (
            <DesktopOnlyNote what="Testing SSH" />
          )
        ) : null}
        {/* Не OpenInDesktop, по той же причине, что и у «SSH Test» выше: хоста
            `refresh-metrics` в parseDeepLinkAction нет (и роут на бэкенде убран
            — снимает метрики десктоп по SSH), так что ссылка вела бы в
            {handled:false} и только тостила бы сама себя. */}
        {s.has_ssh ? (
          isTauri() ? (
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => refreshMetrics.mutate()}
              disabled={refreshMetrics.isPending}
            >
              {refreshMetrics.isPending ? "Refreshing..." : "Refresh metrics"}
            </Btn>
          ) : (
            // Тот же `what`, что в `requireDesktop("Collecting metrics")` внутри
            // `runCollectMetrics`: объяснение запрета не должно разъезжаться
            // между экраном и текстом ошибки.
            <DesktopOnlyNote what="Collecting metrics" />
          )
        ) : null}
        {/* Единственный способ сменить SSH-пароль: до этого модалку открывал
            только баннер «SSH не настроен», который у сервера с секретом не
            показывается, — так что ротация пароля была недостижима из UI.
            В вебе — фраза, а НЕ OpenInDesktop: хоста `server-ssh` в
            parseDeepLinkAction нет, ссылка вела бы в {handled:false} и только
            тостила. Взаимоисключающе с баннером ниже (тот при !has_ssh), так
            что фраза на экране в любом случае одна. */}
        {s.has_ssh ? (
          isTauri() ? (
            <Btn size="sm" variant="secondary" onClick={openSshModal}>Изменить SSH</Btn>
          ) : (
            <DesktopOnlyNote what="Saving secrets" />
          )
        ) : null}
        {/* Сверка сайтов с сервером — чтение по SSH, значит только десктоп (как
            «SSH Test» и «Refresh metrics»). Не OpenInDesktop: хоста
            `sync-domains` в parseDeepLinkAction нет (и не было — старая кнопка
            вела в мёртвый роут), ссылка вела бы в {handled:false} и тостила бы
            сама себя. */}
        {s.has_ssh && isFPInstalled ? (
          isTauri() ? (
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => listSites.mutate()}
              // Гаснет и на время лечения: кнопка стоит прямо над баннером, а
              // перезапуск сверки посреди секундного POST снёс бы колонки из-под
              // ещё не приехавшего ответа — и имена, которые сервер отказался
              // заводить, не показались бы нигде.
              disabled={listSites.isPending || assignServer.isPending || createBound.isPending}
            >
              {listSites.isPending ? "Сверяю…" : "Сверить домены"}
            </Btn>
          ) : (
            // Русская заметка, а не `DesktopOnlyNote` (тот по шаблону
            // английский): кнопка и её пояснение на карточке сервера ведутся
            // по-русски. Чтение сайтов идёт по SSH — из браузера недостижимо.
            <div style={{fontSize:12.5,color:"#6b7280",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 12px"}}>
              Сверка сайтов доступна только в десктоп-приложении SDMP.
            </div>
          )
        ) : null}
        <OpenInDesktop
          variant="danger"
          action={`delete-server?serverId=${s.id}`}
          label="✕ Delete"
          desktopOnClick={handleDelete}
          disabled={delSrv.isPending}
        />
      </div>
    </div>

    {!s.has_ssh && (
      <div style={{background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"14px 18px", marginBottom:20, display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <div>
          <div style={{fontWeight:600, fontSize:14, color:"#92400e", marginBottom:2}}>⚠ SSH-доступ не настроен</div>
          <div style={{fontSize:13, color:"#a16207"}}>Для мониторинга uptime, CPU и диска необходимо добавить SSH-данные.</div>
        </div>
        {/* В вебе — фраза вместо кнопки: пароль шифрует Rust мастер-ключом из
            keychain, из браузера его не сохранить, и форму открывать незачем —
            набранный секрет некуда деть, а открытая форма это обещает. */}
        {isTauri() ? (
          <Btn variant="primary" size="sm" onClick={openSshModal}>Добавить SSH</Btn>
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
    )}

    {/* Отказ ДО выполнения команды (заперт keychain, не принятый ключ хоста,
        отказ в коннекте) — это ошибка мутации, а не её результат: без неё клик
        по кнопке выглядел бы как клик в пустоту.

        Ветвление, а не два блока подряд: react-query не стирает `data` на
        старте следующей попытки, поэтому рядом с красным «не удалось» висел бы
        зелёный ответ прошлого прогона. Обратный порядок безопасен — `error` на
        старте как раз обнуляется. */}
    {testSsh.isError ? (
      <div role="alert" style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
        SSH Test failed: {(testSsh.error as any)?.message || "unknown error"}
      </div>
    ) : testSsh.data ? (
      <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: testSsh.data.success ? "#dcfce7" : "#fee2e2", color: testSsh.data.success ? "#166534" : "#991b1b", fontSize: 13}}>SSH Test: {testSsh.data.message}</div>
    ) : null}
    {/* Сбор метрик отваливается там же, где и SSH Test (заперт keychain, не
        принятый ключ хоста, отказ в коннекте), плюс своё: машина ответила, но
        разобрать из вывода нечего. Без баннера клик по кнопке выглядел бы как
        клик в пустоту — цифры на экране просто остались бы прежними. */}
    {refreshMetrics.isError && (
      <div role="alert" style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
        Refresh metrics failed: {(refreshMetrics.error as any)?.message || "unknown error"}
      </div>
    )}
    {/* Отказ ДО/во время чтения (заперт keychain, не принятый ключ хоста, отказ
        в коннекте) — ошибка мутации. Ветвление, а не два блока: react-query не
        стирает `data` на старте следующей попытки, иначе рядом с красным «не
        удалось» висела бы прошлая удачная сверка. */}
    {listSites.isError ? (
      <div role="alert" style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
        Не удалось прочитать сайты с сервера: {(listSites.error as any)?.message || "request error"}
      </div>
    ) : listSites.data ? (
      /* Сверять есть с чем только при ПРОЧИТАННОМ списке доменов. Пустой список
         вместо непрочитанного — это диагноз «SDMP не знает ни одного домена
         этого сервера», выставленный по отсутствию данных, и лечение под ним
         предлагается такое же уверенное (принцип №6). */
      /* `isLoadingError`, а НЕ `isError`: у query-core «ошибка» и «данных нет» —
         разные вещи, и упавший ФОНОВЫЙ перезапрос даёт `{error, данные есть}`.
         Перезапрос здесь не редкость и не совпадение: его запускает `onSuccess`
         самой привязки (`invalidateQueries`), то есть икота бэкенда в эту
         секунду сносила бы баннер с только что приехавшими именами `skipped` —
         ровно тот отчёт, ради сохранности которого баннер и перестали
         размонтировать. Прочитанные данные остаются знанием, даже когда
         следующее чтение не удалось; сказать надо о том, что они могли
         устареть, а не выбросить их. */
      allDomainsQ.isLoadingError ? (
        <div role="alert" style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
          Сайты с сервера прочитаны, но список доменов SDMP не загрузился — сверять не с чем: {(allDomainsQ.error as any)?.message || "request error"}
        </div>
      ) : allDomainsQ.data ? (
        <>
        {allDomainsQ.isError && (
          <div style={{marginBottom:8, padding: "8px 12px", borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 12.5}}>
            Список доменов SDMP мог устареть: последнее обновление не прошло ({(allDomainsQ.error as any)?.message || "request error"}). Сверка ниже построена на прочитанном раньше.
          </div>
        )}
        <SiteCompareBanner
          sites={listSites.data}
          domains={allDomainsQ.data}
          serverId={s.id}
          serverName={s.name}
          servers={serversList?.items || []}
          assignServer={assignServer}
          createBound={createBound}
          skipped={compareSkipped}
          onSkipped={setCompareSkipped}
        />
        </>
      ) : (
        <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#f9fafb", border: "1px solid #e5e7eb", color: "#6b7280", fontSize: 13}}>
          Сайты с сервера прочитаны; ждём список доменов SDMP, чтобы было с чем сверять.
        </div>
      )
    ) : null}
    {s.last_check_ok === false && s.last_check_error && (
      <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
        Uptime check failed: {s.last_check_error}
      </div>
    )}

    {metricsAt ? (
      <div style={{marginBottom:20}}>
        {/* Подпись возраста — над самими показаниями и одна на все четыре
            карточки: снимок атомарен, у всех полей один возраст. Пометка та же,
            что везде в продукте (`STALE_SUFFIX`), а зов нажать кнопку добавлен
            отдельно — кнопка есть только на этом экране, и здесь совет уместен.
            Сами цифры при этом не исчезают: они настоящие, просто старые. */}
        <div title={new Date(metricsAt).toLocaleString()} style={{fontSize:12.5,color:metricsStale?STALE_TEXT:"#6b7280",marginBottom:8}}>
          Metrics: {formatAgoStale(metricsAt, metricsStale, now)}{metricsStale?" — press «Refresh metrics»":""}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
        <StatCard label="CPU Usage" value={reading(s.cpu_usage_pct != null ? `${s.cpu_usage_pct}%` : null)} sub={s.cpu_count != null ? `${s.cpu_count} vCPU` : "—"} pct={cpuPct} color={cpuPct === undefined ? undefined : metricsStale ? STALE_TEXT : pctColor(cpuPct)}/>
        <StatCard label="RAM Usage" value={reading(s.ram_used_mb != null ? `${mbToGb(s.ram_used_mb)} GB` : null)} sub={s.ram_total_mb != null ? `of ${mbToGb(s.ram_total_mb)} GB` : "—"} pct={ramPct} color={metricsStale?STALE_TEXT:"#7c3aed"}/>
        <StatCard label="SSD Usage" value={reading(s.disk_used_gb != null ? `${s.disk_used_gb} GB` : null)} sub={s.disk_total_gb != null ? `of ${s.disk_total_gb} GB` : "—"} pct={diskPct} color={metricsStale?STALE_TEXT:"#0891b2"}/>
        <StatCard label="Network In" value={reading(s.net_in_kbps != null ? `${(s.net_in_kbps / 1000).toFixed(2)} Mb/s` : null)} sub={s.net_out_kbps != null ? `Out: ${(s.net_out_kbps / 1000).toFixed(2)} Mb/s` : "—"} pct={undefined} color="#059669"/>
        </div>
      </div>
    ) : (
      <Card style={{marginBottom:20}}>
        {/* Не «метрики недоступны»: недоступны они не были, их просто ни разу не
            снимали — снимает их десктоп по кнопке, и до первого нажатия колонки
            пусты. Кнопка названа своим именем, чтобы её было где искать. */}
        <div style={{padding:"18px 20px", fontSize:13, color:"#6b7280"}}>No metrics yet — press «Refresh metrics» to collect them over SSH.</div>
      </Card>
    )}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
      <div>
        {isFPInstalled && <Card style={{marginBottom:16}}>
          <CHd><CTi>⚡ FastPanel Access <Badge variant="blue">v{fp.version}</Badge></CTi><Btn variant="primary" size="sm" onClick={()=>window.open(fp.url)}>↗ Open FastPanel</Btn></CHd>
          <CBo>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><div style={{flex:1,padding:"10px 14px",background:"#eff4ff",border:"1px solid #bfdbfe",borderRadius:8,fontSize:13,color:"#2563eb",fontWeight:500}}>{fp.url}</div><CopyBtn value={fp.url}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {[
                {label:"Login",val:fp.login,pw:false},
                {label:"Password",val:fp.password,pw:true},
                {label:"Port",val:String(fp.port),pw:false},
                {label:"Protocol",val:"HTTPS",pw:false}
              ].map((f, i)=>(
                <div key={i}>
                  <label style={{fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.5px",display:"block",marginBottom:6}}>{f.label}</label>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {f.pw && !isTauri() && s.fastpanel_password_blob_id ? (
                      <RevealSecret blobId={s.fastpanel_password_blob_id} label="Show FastPanel password" />
                    ) : (
                      <>
                        <div style={{flex:1,padding:"8px 12px",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",fontWeight:500,letterSpacing:f.pw&&!showPass?"3px":"normal"}}>{f.pw?(showPass?f.val:"•".repeat(f.val.length)):f.val}</div>
                        {f.pw&&<button type="button" onClick={()=>setShowPass(p=>!p)} style={{padding:"8px 10px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,color:"#6b7280"}}>{showPass?"🙈":"👁"}</button>}
                        <CopyBtn value={f.val}/>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CBo>
        </Card>}

        {!isFPInstalled && <Card style={{marginBottom:16}}>
          <CHd><CTi>⚡ FastPanel Installation</CTi></CHd>
          <CBo>
            {isFPStuck && (
              <div style={{marginBottom:12, padding:"10px 12px", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, fontSize:12.5, color:"#92400e"}}>
                Прошлая попытка осталась в статусе «{s.fastpanel_status}». Запустите установку заново.
              </div>
            )}
            <div style={{marginBottom:12, fontSize:12.5, color:"#6b7280", lineHeight:1.5}}>
              Обновит все пакеты и поставит FastPanel по SSH — 30+ минут. Шаги приходят тостами.
            </div>
            {/* Прогресс идёт отдельным каналом: Rust шлёт `fastpanel:progress`,
                а тостит его один глобальный слушатель в DesktopWorkspace —
                установка переживает уход с этой страницы. */}
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <OpenInDesktop
                variant="primary"
                action={`install-fastpanel?serverId=${s.id}`}
                label={fpRunning ? "Installing…" : "Install FastPanel"}
                desktopOnClick={() => installFp.mutate(undefined)}
                disabled={fpRunning}
              />
              {/* Второй путь рядом с установкой: панель на сервере может уже
                  стоять, и до этой кнопки единственным способом рассказать о ней
                  SDMP была установка заново — получасовая и поверх работающих
                  сайтов. В вебе — заметка, а НЕ
                  OpenInDesktop: хоста `server-connect-fastpanel` в
                  parseDeepLinkAction нет, ссылка вела бы в {handled:false} и
                  только тостила бы сама себя. `what` тот же, что у SSH-формы:
                  запрет один и тот же — пароль шифрует Rust мастер-ключом из
                  keychain, из браузера его не сохранить.

                  `disabled` тот же, что у установки, и по своей причине:
                  подключение ставит `fastpanel_status: "installed"`, карточка
                  установки исчезает вместе с индикатором «Installing…» — идущая
                  установка становится невидимой, а её write-back через полчаса
                  молча перезапишет только что подключённые креды на выданные
                  инсталлятором. `size` тоже общий: сосед — `OpenInDesktop` со
                  своим дефолтным "sm", и без него вторичная кнопка была бы
                  крупнее первичной. */}
              {isTauri() ? (
                <Btn size="sm" variant="secondary" onClick={openConnectModal} disabled={fpRunning}>Connect Existing</Btn>
              ) : (
                <DesktopOnlyNote what="Saving secrets" />
              )}
            </div>
            {fpError && (
              <div role="alert" style={{marginTop:12, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
                Install failed: {fpError.message || String(fpError)}
              </div>
            )}
          </CBo>
        </Card>}

        <Card>
          {/* Кнопки правки в шапке больше нет: каждое правимое поле открывает
              свою форму карандашом в СВОЕЙ строке — точка входа стоит там, где
              видно значение, а не в заголовке карточки, где ещё надо угадать,
              которое из девяти полей она правит.

              Для веба заметка остаётся: строчных карандашей там нет вовсе, и без
              неё карточка молчала бы о том, почему значения нередактируемы. Не
              OpenInDesktop: хостов `server-provider` и соседних в
              parseDeepLinkAction нет, ссылка вела бы в {handled:false} и только
              тостила бы сама себя — та же развилка и по той же причине, что у
              «Изменить SSH» выше. */}
          <CHd><CTi>🖥 Server Information</CTi>{!isTauri() && <DesktopOnlyNote what="Editing servers" />}</CHd>
          <CBo style={{padding:"6px 20px 14px"}}>
            {/* Правка — мутация, а значит только десктоп: в вебе `onEdit` не
                передаётся вовсе, и строка рисуется ровно как раньше. */}
            {([
              {k:"Name", v:s.name, onEdit: isTauri() ? openNameModal : undefined},
              // `editLabel` — потому что скринридер читает «IP» и «OS» по
              // буквам, а не словами: имя кнопки должно звучать так, как это
              // поле называют вслух.
              {k:"IP", v:s.ip_address, onEdit: isTauri() ? openIpModal : undefined, editLabel:"IP address"},
              // Рядом с OS: такой же описательный атрибут железа, и глаз ищет их
              // вместе.
              {k:"Provider", v:s.provider || "—", onEdit: isTauri() ? openProviderModal : undefined},
              {k:"OS", v:osLabel || "—", onEdit: isTauri() ? openOsModal : undefined, editLabel:"operating system"},
              // Ниже — измерения и отметки времени: их правит не человек, а
              // сбор метрик и проверка доступности, поэтому карандашей у них нет.
              {k:"Uptime", v:formatUptime(s.uptime_seconds)},
              // Возраст снимка — сразу под аптаймом, который из него и взят.
              {k:"Metrics", v:metricsAt
                ? <span style={metricsStale?{color:STALE_TEXT}:undefined}>{formatAgoStale(metricsAt, metricsStale, now)}</span>
                : "never"},
              {k:"Status", v:<Badge variant={statusBadgeVariant(uiStatus)}>{uiStatus}</Badge>},
              // И так же под статусом — возраст проверки, из которой он получен.
              // Два сигнала, две отметки: у метрик и у проверки разные источники
              // (десктоп по кнопке против бэкенда раз в 6 часов) и разная
              // свежесть, и общая подпись показывала бы один из них чужой.
              {k:"Last check", v:s.last_check_at
                ? <span style={checkStale?{color:STALE_TEXT}:undefined}>{formatAgoStale(s.last_check_at, checkStale, now)}</span>
                : "never"},
              {k:"Added", v:fmtDate(s.created_at)}
            ]).map(row=><InfoRow key={row.k} {...row}/>)}
          </CBo>
        </Card>
      </div>
      <Card>
        <CHd style={{padding:"0 20px",alignItems:"stretch",gap:0}}>
          <div style={{display:"flex",gap:0,flex:1}}>
            {["overview"].map((k)=>(
              <div key={k} onClick={()=>setTab(k)} style={{padding:"14px 16px",fontSize:13.5,fontWeight:500,cursor:"pointer",borderBottom:`2px solid ${tab===k?"#2563eb":"transparent"}`,color:tab===k?"#2563eb":"#6b7280",whiteSpace:"nowrap"}}>Domains ({domains.length})</div>
            ))}
          </div>
        </CHd>
        <div style={{padding:"10px 16px",borderBottom:"1px solid #e5e7eb",position:"relative"}}>
          <span style={{position:"absolute",left:26,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span>
          <input value={domSearch} onChange={e=>setDS(e.target.value)} placeholder="Filter domains…" style={{width:"100%",padding:"7px 12px 7px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",background:"#f9fafb",boxSizing:"border-box",fontFamily:"inherit"}}/>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{background:"#f9fafb"}}>
              {["Domain","Status","NS",""].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.4px",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filtered.map((d: any)=><tr key={d.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                <td style={{padding:"10px 14px",fontWeight:600,fontSize:13,color:"#111"}}>{d.domain_name}</td><td style={{padding:"10px 14px"}}><Badge variant="gray">{d.status}</Badge></td><td style={{padding:"10px 14px"}}><Badge variant={d.ns_status==="ok"?"green":d.ns_status==="error"?"red":"yellow"}>{d.ns_status==="ok"?"✓":"⏳"}</Badge></td><td style={{padding:"10px 14px"}}><RowActions actions={[
                  { icon: "✎", title: "Edit domain", onClick: () => setEditingDomain(d) },
                  { icon: "✕", title: "Delete domain", variant: "danger", onClick: async () => { if (!(await confirmAction(`Delete ${d.domain_name}?`))) return; deleteDomain.mutate(d.id); } },
                ]}/></td>
              </tr>)}
              {filtered.length===0&&<tr><td colSpan={6} style={{padding:"28px",textAlign:"center",color:"#9ca3af",fontSize:13}}>No domains found{s.has_ssh && isFPInstalled ? '. Нажмите «Сверить домены», чтобы увидеть сайты на сервере.' : ""}</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>

    {showSshModal && (
      <Modal title={s.has_ssh ? "Изменить SSH-доступ" : "Добавить SSH-доступ"} onClose={closeSshModal} width={420}>
        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH User</label><Inp value={sshUser} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setSshUser((e.target as any).value)} placeholder="e.g., root"/></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Password</label><Inp type="password" value={sshPassword.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>sshPassword.setValue((e.target as any).value)} placeholder="••••••••"/></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Port</label><Inp type="number" value={sshPort} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setSshPort(Number((e.target as any).value))} placeholder="22"/></div>
        </div>
        {sshPassword.error && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {sshPassword.error}
          </div>
        )}
        <div style={{marginTop:22}}>
          <Btn variant="primary" onClick={handleSaveSsh} disabled={sshPassword.saving} style={{width:"100%",justifyContent:"center"}}>{sshPassword.saving ? "Saving..." : "Save"}</Btn>
        </div>
      </Modal>
    )}
    {showConnectModal && (
      // Поле пароля без гейта `isTauri()`, в отличие от «Add Server»: сюда
      // попадают только кнопкой, которой в вебе нет вовсе.
      <Modal title="Connect Existing Fastpanel" onClose={closeConnectModal} width={420}>
        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <div>
            {/* Поле открывается уже заполненным (`openConnectModal`), так что
                плейсхолдер видит только тот, кто стёр значение. Схема и порт в
                нём те же, что требует `fastpanelUrlError`: очищенное поле не
                должно подсказывать формат слабее, чем подставленное. */}
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel URL</label>
            <Inp value={fpUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setFpUrl(e.target.value); if(fpConnectErr.url) setFpConnectErr(prev=>({...prev, url:""}));}} placeholder="https://192.168.1.100:8888" style={{borderColor: fpConnectErr.url ? "#dc2626" : undefined}}/>
            {fpConnectErr.url && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{fpConnectErr.url}</div>}
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel Login</label>
            <Inp value={fpLogin} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setFpLogin(e.target.value); if(fpConnectErr.login) setFpConnectErr(prev=>({...prev, login:""}));}} placeholder="Enter login" style={{borderColor: fpConnectErr.login ? "#dc2626" : undefined}}/>
            {fpConnectErr.login && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{fpConnectErr.login}</div>}
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel Password</label>
            <Inp type="password" value={fpPassword.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{fpPassword.setValue(e.target.value); if(fpConnectErr.password) setFpConnectErr(prev=>({...prev, password:""}));}} placeholder="Enter password" style={{borderColor: fpConnectErr.password ? "#dc2626" : undefined}}/>
            {fpConnectErr.password && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{fpConnectErr.password}</div>}
          </div>
        </div>
        {fpPassword.error && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {fpPassword.error}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
          {/* Кнопка мёртвая всё время записи блоба И сохранения сервера: между
              ними нет кадра, где `saving` ложен, — второй клик писал бы второй
              блоб на тот же секрет. */}
          <Btn variant="primary" onClick={handleSaveConnect} disabled={fpPassword.saving} style={{width:"100%",justifyContent:"center"}}>{fpPassword.saving ? "Saving..." : "Save"}</Btn>
          <Btn variant="secondary" onClick={closeConnectModal} disabled={fpPassword.saving} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {showNameModal && (
      <Modal title="Rename server" onClose={()=>setShowNameModal(false)} width={420}>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Server Name</label>
          {/* Плейсхолдер и подпись — те же, что в «Add Server»: поле одно и то
              же, и разные примеры в двух формах читались бы как разные правила
              именования. */}
          <Inp
            value={nameValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setNameValue(e.target.value); setNameErr(null);}}
            placeholder="e.g., production-web-01"
            style={{borderColor: nameErr ? "#dc2626" : undefined}}
          />
        </div>
        {nameErr && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {nameErr}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
          <Btn variant="primary" onClick={handleSaveName} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>{updateServer.isPending ? "Saving..." : "Save"}</Btn>
          <Btn variant="secondary" onClick={()=>setShowNameModal(false)} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {showProviderModal && (
      <Modal title="Hosting Provider" onClose={()=>setShowProviderModal(false)} width={420}>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Hosting Provider <span style={{color:"#9ca3af",fontWeight:400}}>(optional)</span></label>
          {/* Свободный текст с подсказками, как и в форме добавления: список
              провайдеров нигде не зафиксирован, но значение служит ключом
              группировки для фильтра — «hetzner» рядом с «Hetzner» дали бы двух
              разных провайдеров. */}
          <Inp
            value={provider}
            list={PROVIDER_LIST_ID}
            onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setProvider(e.target.value); setProviderErr(null);}}
            placeholder="e.g., Hetzner"
            style={{borderColor: providerErr ? "#dc2626" : undefined}}
          />
          <datalist id={PROVIDER_LIST_ID}>
            {providers.map(p=><option key={p} value={p}/>)}
          </datalist>
          <div style={{fontSize:11.5,color:"#9ca3af",marginTop:6}}>Очистите поле, чтобы убрать провайдера.</div>
        </div>
        {providerErr && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {providerErr}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
          <Btn variant="primary" onClick={handleSaveProvider} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>{updateServer.isPending ? "Saving..." : "Save"}</Btn>
          <Btn variant="secondary" onClick={()=>setShowProviderModal(false)} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {showIpModal && (
      <Modal title="IP Address" onClose={()=>setShowIpModal(false)} width={420}>
        <div>
          {/* `htmlFor`/`id`, в отличие от соседних форм этого файла: без пары
              скринридер объявляет поле безымянным, а `<label>` рядом сам по себе
              его не именует. Соседи это правило нарушают исторически — новый код
              его не тиражирует. */}
          <label htmlFor={IP_INPUT_ID} style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>IP Address</label>
          {/* Плейсхолдер тот же, что в «Add Server»: поле одно и то же, и разные
              примеры в двух формах читались бы как разные правила записи. */}
          <Inp
            id={IP_INPUT_ID}
            value={ipValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setIpValue(e.target.value); setIpErr(null);}}
            placeholder="e.g., 192.168.1.100"
            style={{borderColor: ipErr ? "#dc2626" : undefined}}
          />
        </div>
        {ipErr && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {ipErr}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
          <Btn variant="primary" onClick={handleSaveIp} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>{updateServer.isPending ? "Saving..." : "Save"}</Btn>
          <Btn variant="secondary" onClick={()=>setShowIpModal(false)} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {showOsModal && (
      <Modal title="Operating System" onClose={()=>setShowOsModal(false)} width={420}>
        <div>
          <label htmlFor={OS_SELECT_ID} style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>OS</label>
          {/* Закрытый список, а не свободный текст, — тот же `OS_OPTIONS`, что и
              в «Add Server»: по этому имени десктоп выбирает пакетный менеджер
              для установки FastPanel, и «убунту» руками сломало бы установку
              молча (см. JSDoc `OS_OPTIONS`). */}
          <Sel id={OS_SELECT_ID} value={osValue ?? ""} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>{setOsValue(e.target.value as (typeof OS_OPTIONS)[number]); setOsErr(null);}} style={{width:"100%"}}>
            {/* Семейство, которого в списке нет, — нерабочим пунктом с его
                НАСТОЯЩИМ именем (тем же `osLabel`, что в строке карточки):
                селект не вправе называть ОС иначе, чем строка, из которой его
                открыли. Выбрать этот пункт нельзя, сохранить — тоже (кнопка
                мертва, пока не выбрано настоящее значение). */}
            {!osValue && (
              <option value="" disabled>{osLabel ? `${osLabel} — не в списке` : "ОС не определена"}</option>
            )}
            {OS_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
          </Sel>
          {/* Правда от машины — рядом с выбором, но НЕ вместо него: ручной выбор
              перекрывает автоопределение осознанно (см. `serverOsName`), и
              подсказка ничего не меняет сама. Она лишь показывает расхождение,
              которое иначе не видно нигде. */}
          {osMismatch && (
            <div style={{fontSize:11.5,color:"#9ca3af",marginTop:6}}>По SSH определено: {osMismatch}</div>
          )}
        </div>
        {osErr && (
          <div role="alert" style={{marginTop:14, padding:"10px 12px", background:"#fee2e2", borderRadius:8, color:"#991b1b", fontSize:13}}>
            {osErr}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
          {/* Мертва и пока ничего не выбрано: сохранять «то, что показал
              селект» тут нечего — показать он мог и «Fedora — не в списке». */}
          <Btn variant="primary" onClick={handleSaveOs} disabled={updateServer.isPending || !osValue} style={{width:"100%",justifyContent:"center"}}>{updateServer.isPending ? "Saving..." : "Save"}</Btn>
          <Btn variant="secondary" onClick={()=>setShowOsModal(false)} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {editingDomain && (
      <Modal title={`Edit ${editingDomain.domain_name}`} onClose={()=>setEditingDomain(null)} width={450}>
        <DomainEditor
          domain={editingDomain}
          onCancel={() => setEditingDomain(null)}
          onSave={(payload) => updateDomain.mutate(payload, { onSuccess: () => setEditingDomain(null) })}
          isSaving={updateDomain.isPending}
        />
      </Modal>
    )}
  </>;
}

function DomainEditor({ domain, onSave, onCancel, isSaving }: { domain: any; onSave: (payload: any) => void; onCancel: () => void; isSaving: boolean }) {
  const [name, setName] = useState(domain.domain_name || "");
  const [purchaseDate, setPurchaseDate] = useState(domain.purchase_date || "");
  const [expiryDate, setExpiryDate] = useState(domain.expiry_date || "");
  const [zoneId, setZoneId] = useState(domain.cloudflare_zone_id || "");

  return (
    <>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setName((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Purchase Date</label><Inp type="date" value={purchaseDate} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setPurchaseDate((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Expiry Date</label><Inp type="date" value={expiryDate} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setExpiryDate((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Cloudflare Zone ID</label><Inp value={zoneId} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setZoneId((e.target as any).value)} /></div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
        <Btn variant="primary" disabled={isSaving || !name.trim()} onClick={() => onSave({ domain_name: name.trim(), purchase_date: purchaseDate || null, expiry_date: expiryDate || null, cloudflare_zone_id: zoneId || null })} style={{width:"100%",justifyContent:"center"}}>{isSaving ? "Saving..." : "Save"}</Btn>
        <Btn variant="secondary" onClick={onCancel} disabled={isSaving} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
      </div>
    </>
  );
}
