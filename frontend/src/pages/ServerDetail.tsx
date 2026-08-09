import React, { useState } from "react";
import { useMutationState } from "@tanstack/react-query";
import { StatCard, Card, CHd, CTi, CBo, Btn, StatusDot, Badge, fmtDate, pctColor, mbToGb, InfoRow, CopyBtn, Modal, Inp, RowActions, formatUptime, formatAgoStale, STALE_SUFFIX, STALE_TEXT } from "../components/ui/Primitives";
import { useServer, useServers, useDeleteServer, useTestSsh, useInstallFastPanel, installFastPanelKey, useUpdateServer, useRefreshMetrics, useSyncServerDomains } from "../api/servers";
import { providerError, providerOptions, providerPayload } from "../lib/providerInput";
import { fastpanelUrlError, fastpanelUserError } from "../lib/fastpanelInput";
import { isCheckStale, isMetricsStale, serverUiStatus, statusBadgeVariant } from "../lib/serverStatus";
import { useDomains, useDeleteDomain, useUpdateDomain } from "../api/domains";
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

/**
 * Адрес панели: свой, если известен, иначе собранный из адреса сервера. Одним
 * выражением на карточку доступа и на форму подключения — разъехавшись, они
 * показывали бы человеку один URL, а сохраняли другой.
 */
function fastpanelUrlOf(server: any): string {
  return server?.fastpanel_url || `https://${server?.ip_address}:8888`;
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

  // Queries
  const { data: s } = useServer(server?.id);
  // Подсказки провайдеров берём из общего списка серверов — того же запроса,
  // что уже загрузила страница Servers (ключ ["servers"]), так что сюда приходят
  // из кэша. Отдельного эндпоинта «список провайдеров» нет намеренно: второй
  // источник тех же значений умел бы разойтись с первым.
  const { data: serversList } = useServers();
  const { data: domainsData } = useDomains({ server_id: server?.id });
  const domains = domainsData ?? [];
  
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
  const syncDomains = useSyncServerDomains(server?.id || 0);
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
    // Адрес панели собирается из `ip_address` самого сервера: здесь он уже
    // известен, тогда как в «Add Server» сервера ещё нет и IP приходится
    // выковыривать обратно из набранного URL. Пустое поле заставляло бы
    // набирать руками то, что программа и так знает.
    setFpUrl(fastpanelUrlOf(s));
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
    // Формулировка — та же, что во вкладке connect «Add Server»: поле одно и то
    // же, и два разных текста читались бы как два разных требования.
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
        // Те же поля, что у connect-ветки «Add Server», но через PUT: сервер уже
        // заведён. `fastpanel_status` обязателен — без него блок установки так и
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
  const osLabel = s.os_pretty || s.os || null;
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
        {s.has_ssh && isFPInstalled ? (
          <OpenInDesktop
            action={`sync-domains?serverId=${s.id}`}
            label={syncDomains.isPending ? "Syncing..." : "Sync Domains"}
            desktopOnClick={() => syncDomains.mutate()}
            disabled={syncDomains.isPending}
          />
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
    {syncDomains.data && (
      <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: syncDomains.data.error ? "#fee2e2" : "#dcfce7", color: syncDomains.data.error ? "#991b1b" : "#166534", fontSize: 13}}>
        {syncDomains.data.error
          ? `Sync failed: ${syncDomains.data.error}`
          : `Synced ${syncDomains.data.total} domains (${syncDomains.data.created} new, ${syncDomains.data.linked} linked).`}
      </div>
    )}
    {syncDomains.isError && (
      <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b", fontSize: 13}}>
        Sync failed: {(syncDomains.error as any)?.message || "request error"}
      </div>
    )}
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
          {/* Правка — мутация, а значит только десктоп. Не OpenInDesktop: хоста
              `server-provider` в parseDeepLinkAction нет, ссылка вела бы в
              {handled:false} и только тостила бы сама себя — та же развилка и по
              той же причине, что у «Изменить SSH» выше. */}
          <CHd><CTi>🖥 Server Information</CTi>{isTauri() ? (
            <Btn size="sm" variant="secondary" onClick={openProviderModal}>✎ Provider</Btn>
          ) : (
            <DesktopOnlyNote what="Editing servers" />
          )}</CHd>
          <CBo style={{padding:"6px 20px 14px"}}>
            {[
              ["Name",s.name],
              ["IP",s.ip_address],
              // Рядом с OS: такой же описательный атрибут железа, и глаз ищет их
              // вместе.
              ["Provider",s.provider || "—"],
              ["OS",osLabel || "—"],
              ["Uptime", formatUptime(s.uptime_seconds)],
              // Возраст снимка — сразу под аптаймом, который из него и взят.
              ["Metrics", metricsAt
                ? <span key="metrics" style={metricsStale?{color:STALE_TEXT}:undefined}>{formatAgoStale(metricsAt, metricsStale, now)}</span>
                : "never"],
              ["Status",<Badge key="status" variant={statusBadgeVariant(uiStatus)}>{uiStatus}</Badge>],
              // И так же под статусом — возраст проверки, из которой он получен.
              // Два сигнала, две отметки: у метрик и у проверки разные источники
              // (десктоп по кнопке против бэкенда раз в 6 часов) и разная
              // свежесть, и общая подпись показывала бы один из них чужой.
              ["Last check", s.last_check_at
                ? <span key="check" style={checkStale?{color:STALE_TEXT}:undefined}>{formatAgoStale(s.last_check_at, checkStale, now)}</span>
                : "never"],
              ["Added",fmtDate(s.created_at)]
            ].map(([k,v], i)=><InfoRow key={i} k={k} v={v}/>)}
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
              {filtered.length===0&&<tr><td colSpan={6} style={{padding:"28px",textAlign:"center",color:"#9ca3af",fontSize:13}}>No domains found{s.has_ssh && isFPInstalled ? '. Click "Sync Domains" to pull sites from FastPanel.' : ""}</td></tr>}
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
            {/* Подписи и плейсхолдеры — те же, что в «Add Server»: поля те же
                самые, и разные примеры в двух формах читались бы как разные
                требования к значению. */}
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
