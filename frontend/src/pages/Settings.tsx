import React, { useState } from "react";
import { Card, CHd, CTi, CBo, StatCard, Badge, Btn, Modal, Inp, EmptyState, ErrorState } from "../components/ui/Primitives";
import { useRegistrarAccounts, useCreateRegistrarAccount, useTestRegistrarConnection, useUpdateRegistrarAccount, useDeleteRegistrarAccount, RegistrarProvider } from "../api/registrars";
import { useSystemConfig, useTestNotificationDelivery, useUpdateSystemConfig } from "../api/settings";
import { describeQueryError } from "../lib/queryError";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { confirmAction } from "../lib/confirmDialog";
import { BLOB_KIND } from "../lib/secretBlob";
import { useMultiSecretSave } from "../hooks/useSecretSave";
import { apiUserField, hasApi, needsClientIp, providerMeta } from "../lib/registrarProviders";
import { ProviderCombobox } from "../components/settings/ProviderCombobox";
import { ProviderAvatar, ProviderApiTag, ProviderLabel } from "../components/settings/ProviderVisuals";
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";
import RecoveryPhraseCard from "./RecoveryPhraseCard";
import ChangePasswordCard from "./ChangePasswordCard";

/**
 * Как поля секретов регистратора называются пользователю. Одни и те же на
 * форме создания и правки: из них хук собирает и «… is required», и текст
 * ошибки записи, а два набора формулировок разъехались бы.
 *
 * `apiSecret` — это НЕ второй ключ: десктоп отдаёт его Namecheap как
 * whitelisted client IP (`commands/registrars.rs`), поэтому и подпись про IP.
 *
 * ИЗМЕНЕНИЕ ПОВЕДЕНИЯ: на создании Namecheap-аккаунта IP теперь ОБЯЗАТЕЛЕН —
 * ключ всегда объявлен в `saveAll`, а пустое значение хук отбивает. Раньше
 * аккаунт заводился вообще без IP, и это была ловушка: поле было нарисовано,
 * но никуда не вело, а десктоп подставлял `127.0.0.1` (`make_service`), после
 * чего Namecheap отбивал вызовы по whitelist. Отказ формы честнее, чем
 * заведённый аккаунт, который не работает и не говорит почему. У Hostiq поля
 * нет, ключ не объявляется, `api_secret_blob_id` остаётся NULL — и это верно:
 * этот параметр Hostiq не получает вовсе. У ручного провайдера (`hasApi` = false)
 * не объявляется НИ ОДИН из двух: полей секретов у него нет, и оба `*_blob_id`
 * остаются NULL — ярлык, по которому раскладывают домены, а не учётка.
 */
const REGISTRAR_SECRETS = { apiKey: "API key", apiSecret: "Client IP" } as const;

export default function Settings(){
  const { data: registrarsData, isPending, isError, error } = useRegistrarAccounts();
  const testReg = useTestRegistrarConnection();
  const deleteReg = useDeleteRegistrarAccount();
  const { data: systemConfigData } = useSystemConfig();
  const updateSystemConfig = useUpdateSystemConfig();
  const testDelivery = useTestNotificationDelivery();

  const registrars = registrarsData || [];

  const [tab,setTab]=useState("registrars"); const [showAdd,setSA]=useState(false);

  const [testing,setTest]=useState<any>({}); const [testRes,setRes]=useState<any>({});
  const [editingRegistrar, setEditingRegistrar] = useState<any | null>(null);
  const [editingSystem, setEditingSystem] = useState<{ key: string; value: string } | null>(null);
  const [testResult, setTestResult] = useState<{ webhook: string; telegram: string } | null>(null);
  const systemConfig = systemConfigData || [
    { key: "API Base URL", value: "http://localhost:8100/api", editable: false },
    { key: "Frontend URL", value: "http://localhost:3100", editable: false },
    { key: "Backend Port", value: "8100", editable: true },
    { key: "Postgres Port", value: "5532", editable: false },
    { key: "Redis Port", value: "6479", editable: false },
    { key: "Celery Workers", value: "2", editable: true },
    { key: "Task Time Limit", value: "60 min", editable: true },
    { key: "FastPanel Poll", value: "3 seconds", editable: true },
    { key: "Webhook Enabled", value: "false", editable: true },
    { key: "Webhook URL", value: "", editable: true },
    { key: "Webhook Secret", value: "", editable: true },
    { key: "Telegram Enabled", value: "false", editable: true },
    { key: "Auto Temp Mail Enabled", value: "false", editable: true },
  ];

  const getConfigValue = (key: string, fallback = "") =>
    systemConfig.find((item) => item.key === key)?.value ?? fallback;
  const isEnabled = (key: string) => ["true", "1", "yes", "on", "enabled"].includes(getConfigValue(key).toLowerCase());
  const toggleConfig = (key: string) =>
    updateSystemConfig.mutate({ key, value: isEnabled(key) ? "false" : "true" });

  
  const handleTest=(id: number)=>{
    setTest((p: any)=>({...p,[id]:true}));
    setRes((p: any)=>({...p,[id]:null}));
    testReg.mutate(id, {
      onSuccess: (data) => {
        setTest((p: any)=>({...p,[id]:false}));
        setRes((p: any)=>({...p,[id]:data.success?"ok":"error"}));
      },
      onError: () => {
        setTest((p: any)=>({...p,[id]:false}));
        setRes((p: any)=>({...p,[id]:"error"}));
      }
    });
  };

  return <>
    <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Settings</h1><div style={{fontSize:13,color:"#6b7280"}}>Manage integrations and system configuration</div></div>
    <div style={{display:"flex",gap:0,borderBottom:"1px solid #e5e7eb",marginBottom:24}}>
      {[["registrars","📋 Registrars"],["system","⚙ System"],["encryption","🔑 Encryption"]].map(([k,l])=>(
        <div key={k} onClick={()=>setTab(k)} style={{padding:"11px 20px",fontSize:13.5,fontWeight:500,cursor:"pointer",borderBottom:`2px solid ${tab===k?"#2563eb":"transparent"}`,marginBottom:-1,color:tab===k?"#2563eb":"#6b7280"}}>{l}</div>
      ))}
    </div>
    {tab==="registrars"&&<>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:"#111"}}>Registrar Accounts <span style={{fontSize:13,fontWeight:400,color:"#9ca3af"}}>({registrars.length})</span></div>
        {/* В вебе на месте кнопки заметка, а не форма за ней: почему так и
            почему без дип-линка — тот же блок в `Cloudflare.tsx`. */}
        {isTauri() ? (
          <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Registrar</Btn>
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
        {[
          ["Total",registrars.length,"#2563eb"],
          ["Active",registrars.filter((r: any)=>r.is_active).length,"#16a34a"]
        ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
      </div>
      {isError ? (
        <ErrorState
          title={describeQueryError(error).title}
          message={`Registrar accounts could not be loaded. ${describeQueryError(error).message}`}
          hint={describeQueryError(error).hint}
        />
      ) : isPending ? (
        <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading registrars...</div>
      ) : registrars.length === 0 ? (
        <Card>
          {/* Пустое состояние больше не обещает только двоих: провайдером теперь
              может быть любой. Hostiq и Namecheap подключаются учётными данными
              и умеют Test/Set NS, остальные заводятся ярлыком — по нему домены
              раскладывают, но API у них нет (см. `registrarProviders`). */}
          <EmptyState
            title="No registrar accounts yet"
            description="Add Hostiq or Namecheap credentials for API access, or any other registrar as a label to group domains."
          >
            {/* Второй вход в ту же форму — и в вебе он закрыт по той же причине;
                объяснение уже стоит в шапке, повторять его тут незачем. */}
            {isTauri() ? <Btn variant="primary" onClick={() => setSA(true)}>+ Add Registrar</Btn> : null}
          </EmptyState>
        </Card>
      ) : registrars.map((r: any)=>{
        // ВСЁ про показ провайдера — из одного `providerMeta`: и аватар, и
        // подпись, и `m.api`. Раньше карточка знала про провайдеров сама
        // (зашитый `plMap` и тернарник «hostiq или Namecheap»), и любой другой
        // provider получал «?» на сером и подпись «Namecheap» — то есть карточка
        // прямо врала о том, к какому регистратору привязаны домены.
        //
        // `m.api` — тот же предикат `hasApi`, что решает про поля формы: отдельный
        // вызов рядом с `providerMeta` был бы вторым ответом на один вопрос, и
        // бейдж «API» однажды разъехался бы с кнопкой Test внутри одной строки.
        //
        // `null` из ответа сервера страховать здесь не надо: `providerMeta` его
        // принимает сама и отвечает «?» с чипом manual. Страховка стояла на трёх
        // местах вызова — три нормализации одного значения, каждая своя.
        const m = providerMeta(r.provider);
        return <Card key={r.id} style={{marginBottom:12}}>
          <div style={{padding:"16px 20px",display:"flex",alignItems:"center",gap:14}}>
            <ProviderAvatar m={m} size={38} />
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <span style={{fontSize:14.5,fontWeight:700,color:"#111"}}>{r.name}</span>
                <Badge variant={r.is_active?"green":"gray"}>{r.is_active?"Active":"Inactive"}</Badge>
                <ProviderApiTag api={m.api} />
              </div>
              {/* Точка появляется только вместе с тем, что за ней стоит. Пустых
                  хвостов здесь два, и оба живые:
                  — ручной провайдер: `api_user` у него всегда NULL (форма его не
                    спрашивает), и на этом месте прямо сказано «manual»;
                  — API-провайдер без логина: `AddRegistrarModal` API User не
                    требует (кнопка гейтится только именем аккаунта), да и колонка
                    nullable — старые строки и чужой импорт дают `null`. Тогда
                    остаётся одна метка провайдера.
                  «Hostiq · » с оборванным хвостом читается как «тут что-то было и
                  пропало» — ровно то враньё, ради которого строку переписывали.
                  Заметим: бейдж «API» при этом остаётся зелёным, и это верно — он
                  про способность провайдера, а не про полноту учётки; неполную
                  учётку показывает Test своим «✕ Failed». Чинить это надо в форме
                  (обязательность поля), а не в подписи. */}
              <div style={{fontSize:12.5,color:"#6b7280"}}>
                {/* Не `m.label`: у провайдера с мусором в колонке (`"  hostiq  "`)
                    метка тримлена, и признак поломки исчезал с экрана — см. JSDoc
                    `ProviderLabel`. В обычном случае это ровно метка. */}
                <ProviderLabel m={m} />
                {m.api
                  ? (r.api_user ? <> · <span style={{fontFamily:"monospace"}}>{r.api_user}</span></> : null)
                  : " · manual"}
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {/* Test и его результат — только у API-провайдера: у ручного за этой
                  кнопкой стоит `unknown provider` от десктопа, то есть красное
                  «✕ Failed» на аккаунте, с которым всё в порядке. Edit и удаление
                  остаются у всех: ярлык переименовывают и убирают, как любой
                  другой аккаунт. */}
              {m.api&&testRes[r.id]&&<Badge variant={testRes[r.id]==="ok"?"green":"red"}>{testRes[r.id]==="ok"?"✓ Connected":"✕ Failed"}</Badge>}
              {m.api&&<Btn size="sm" variant="secondary" onClick={()=>handleTest(r.id)} disabled={testing[r.id]}>{testing[r.id]?"Testing…":"🔌 Test"}</Btn>}
              <Btn size="sm" variant="secondary" onClick={() => setEditingRegistrar(r)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger" onClick={async () => { if (!(await confirmAction(`Delete registrar ${r.name}?`))) return; deleteReg.mutate(r); }}>✕</Btn>
            </div>
          </div>
        </Card>;
      })}
      {showAdd && <AddRegistrarModal onClose={()=>setSA(false)} accounts={registrars} />}
    </>}
    {tab==="system"&&<Card>
      <CHd><CTi>⚙ System Configuration</CTi></CHd>
      <CBo style={{padding:"6px 20px 14px"}}>
        <div style={{padding:"12px 0",borderBottom:"1px solid #f3f4f6"}}>
          <div style={{fontSize:13.5,fontWeight:600,color:"#111",marginBottom:10}}>Notification Channels</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            <Btn size="sm" variant={isEnabled("Webhook Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Webhook Enabled")}>
              {isEnabled("Webhook Enabled") ? "Webhook: ON" : "Webhook: OFF"}
            </Btn>
            <Btn size="sm" variant={isEnabled("Telegram Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Telegram Enabled")}>
              {isEnabled("Telegram Enabled") ? "Telegram: ON" : "Telegram: OFF"}
            </Btn>
            <Btn size="sm" variant={isEnabled("Auto Temp Mail Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Auto Temp Mail Enabled")}>
              {isEnabled("Auto Temp Mail Enabled") ? "Auto Temp Mail: ON" : "Auto Temp Mail: OFF"}
            </Btn>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <Btn
              size="sm"
              variant="secondary"
              disabled={testDelivery.isPending}
              onClick={() =>
                testDelivery.mutate(
                  { title: "SDMP test notification", message: "Manual test from Settings." },
                  { onSuccess: (res) => setTestResult(res) }
                )
              }
            >
              {testDelivery.isPending ? "Testing..." : "Test delivery"}
            </Btn>
            {testResult ? (
              <span style={{fontSize:12.5,color:"#374151"}}>
                webhook: <b>{testResult.webhook}</b> · telegram: <b>{testResult.telegram}</b>
              </span>
            ) : null}
          </div>
        </div>
        {systemConfig.map((item)=>(
          <div key={item.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{item.key}</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,fontFamily:"monospace",fontWeight:600,color:"#111"}}>{item.value}</span>{item.editable&&<Btn size="sm" variant="ghost" onClick={() => setEditingSystem({ key: item.key, value: item.value })} style={{color:"#2563eb",padding:"4px 8px"}}>Edit</Btn>}</div>
          </div>
        ))}
      </CBo>
    </Card>}
    {tab==="encryption"&&<><Card>
      <CHd><CTi>🔑 Encryption Settings</CTi></CHd>
      <CBo>
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:9,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:10}}>
          <span style={{fontSize:18}}>✓</span>
          <div><div style={{fontSize:13.5,fontWeight:600,color:"#16a34a"}}>{ENCRYPTION_BANNER.title}</div><div style={{fontSize:12.5,color:"#15803d",marginTop:2}}>{ENCRYPTION_BANNER.body}</div></div>
        </div>
        {ENCRYPTION_INFO.map(([k,v])=>(
          <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{k}</div>
            <div style={{fontSize:13,fontWeight:600,color:"#111",textAlign:"right",maxWidth:340}}>{v}</div>
          </div>
        ))}
      </CBo>
    </Card>
    <ChangePasswordCard />
    <RecoveryPhraseCard />
    </>}
    {editingRegistrar && <EditRegistrarModal registrar={editingRegistrar} onClose={() => setEditingRegistrar(null)} />}
    {editingSystem && <Modal title={`Edit ${editingSystem.key}`} onClose={() => setEditingSystem(null)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Value</label><Inp value={editingSystem.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setEditingSystem((p)=>p?({...p, value:(e.target as any).value}):p)} /></div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}>
        <Btn variant="primary" style={{flex:1,justifyContent:"center"}} disabled={updateSystemConfig.isPending} onClick={() => {
          if (!editingSystem) return;
          updateSystemConfig.mutate({ key: editingSystem.key, value: editingSystem.value }, { onSuccess: () => setEditingSystem(null) });
        }}>{updateSystemConfig.isPending ? "Saving..." : "Save"}</Btn>
        <Btn variant="secondary" style={{flex:1,justifyContent:"center"}} onClick={() => setEditingSystem(null)}>Cancel</Btn>
      </div>
    </Modal>}
  </>;
}

/**
 * Добавление аккаунта регистратора. Отдельный экспортируемый компонент, а не
 * блок внутри страницы, ровно по той же причине, что и `AddServerModal`:
 * гварды `isTauri()` на полях секретов и кнопке сохранения — это последний
 * рубеж на случай второго вызывающего, и проверить его можно, только отрендерив
 * форму НАПРЯМУЮ. Пока она была инлайном, веб-тест мог лишь кликнуть кнопку,
 * которой в вебе нет, и все утверждения о содержимом выполнялись вакуумно —
 * мутация «все гварды в `true`» проходила зелёной.
 *
 * Плейнтексты стирать при закрытии больше не нужно: страница монтирует форму
 * условно, и `useMultiSecretSave` уезжает вместе с ней.
 *
 * `accounts` — заведённые аккаунты, из них выпадашка достаёт «ранее
 * использованных» провайдеров. Проп НЕобязателен намеренно: это обогащение
 * списка, а не входные данные формы. Пустой список — законное состояние (первый
 * запуск, ноль аккаунтов: в выпадашке остаётся API-каталог и «создать своего»),
 * поэтому дефолт `[]` ничего не прячет; зато прямой рендер формы — тот самый
 * веб-тест гвардов выше — остаётся про гварды, а не про списки.
 */
export function AddRegistrarModal({ onClose, accounts = [] }: { onClose: () => void; accounts?: { provider: string }[] }) {
  const [provider,setProvider]=useState<RegistrarProvider>("hostiq");
  const [accName, setAccName] = useState("");
  const [apiUser, setApiUser] = useState("");
  // Плейнтексты обоих секретов держит хук, а не форма: он же знает, когда их
  // стереть, и он же гарантирует «оба блоба → один POST» (см. useSecretSave).
  const secrets = useMultiSecretSave(REGISTRAR_SECRETS);
  const createReg = useCreateRegistrarAccount();

  // Есть ли у провайдера рабочий API-клиент в десктопе. От этого зависит ВСЁ
  // остальное в форме: набор полей, состав объявленных секретов и тело POST.
  const api = hasApi(provider);
  // Подсказки поля «API User» — свойство провайдера, и лежат они в каталоге
  // рядом с остальным его показом (у ручного — пустые: поля у него нет).
  const userField = apiUserField(provider);

  const handleAdd = async () => {
    // На СОЗДАНИИ ключи объявляются всегда: пропущенный ключ значит
    // `*_blob_id = NULL` — тот самый 200 OK и «registrar account has no
    // api_key_blob_id» в каждой команде. «Не меняем» бывает только на правке.
    // Client IP объявляем ровно тогда, когда у формы есть его поле.
    //
    // Ручной провайдер идёт ТЕМ ЖЕ путём, с пустым `secrets`, а не отдельной
    // веткой мимо хука. Пустой набор — рабочий путь `saveAll` (им же ходит
    // «переименование без секретов» в правке): записывать нечего, `persist`
    // всё равно зовётся. Ветка в обход стоила бы обоих каналов обратной связи
    // на ту же кнопку — `saving` (не гаснет → двойной клик заводит два
    // аккаунта) и `error` (упавший POST не показать некуда).
    const ok = await secrets.saveAll({
      secrets: api
        ? {
            apiKey: { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: null },
            ...(needsClientIp(provider)
              ? { apiSecret: { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: null } }
              : {}),
          }
        : {},
      persist: async (blobIds) => {
        await createReg.mutateAsync({
          provider,
          // `trim` — то же, что делает `patch` в правке: расходись они, и первая
          // же правка аккаунта, заведённого с пробелами по краям, молча его
          // переименовала бы. Гейт кнопки уже считает пробельное имя пустым,
          // сервер имя не чистит (`RegistrarAccountCreate.name: str`, без
          // валидатора) — значит чистит форма, и в обеих половинах одинаково.
          name: accName.trim(),
          // У ручного провайдера учётных полей нет вовсе: `api_user` уезжает
          // жёстким `null`, а не остатком от провайдера, выбранного до него.
          api_user: api ? apiUser : null,
          // Спредом, а не `*_blob_id: undefined`: полей, которых у провайдера
          // быть не должно, в теле быть не должно тоже, а ключ со значением
          // undefined — это уже ключ (серверная схема `extra="forbid"`).
          // У API-провайдера `apiKey` здесь есть всегда: он объявлен выше, а
          // пустой плейнтекст хук отбивает до первой записи.
          ...(blobIds.apiKey ? { api_key_blob_id: blobIds.apiKey } : {}),
          ...(blobIds.apiSecret ? { api_secret_blob_id: blobIds.apiSecret } : {}),
        });
      },
    });
    if (ok) onClose();
  };

  // Провайдер меняет НАБОР полей — и поэтому сбрасывает набранное: Client IP,
  // набранный для Namecheap, на Hostiq в сохранение уже не попадёт, а плейнтекст
  // жил бы до размонтирования; ошибка «Client IP is required» после переключения
  // ссылалась бы на поле, которого на экране нет. Переход на ручного провайдера —
  // тот же случай, только резче: полей секретов у него нет вовсе, и набранный
  // ключ иначе лежал бы в форме невидимым до её закрытия. Во время записи блоба
  // не пускаем вовсе: `setError` упавшей записи приземлился бы на форму с другим
  // набором полей (сам комбобокс на это время тоже погашен — это второй рубеж).
  //
  // Сравнение строгое, а не по `normalizeProvider`: провайдер теперь свободная
  // строка и в колонку уезжает как есть, так что «GoDaddy» при текущем «godaddy» —
  // другое значение, и записать надо именно новое. Отличаться регистром при этом
  // могут только ручные ярлыки (у каталожных пунктов наружу уходит нормализованный
  // ключ, см. `ProviderCombobox`), а у них полей секретов нет — сбрасывать нечего.
  //
  // ПРЕДПОСЫЛКА, на которой это стоит: `next` приходит из комбобокса, то есть уже
  // нормализован (каталожный пункт) или тримлен (ручной пункт и создание). Подай
  // сюда `value` из колонки БД дословно — например `"Hostiq"` после чужого импорта —
  // и повторный выбор Hostiq из списка вернёт `"hostiq"`: строки разные, провайдер
  // тот же, и `reset()` сотрёт набранный ключ без единого видимого изменения.
  //
  // `apiUser` намеренно НЕ сбрасываем: это не секрет, а логин, и он всегда виден
  // в своём поле, когда поле показано. У ручного провайдера в POST вместо него
  // уезжает жёсткий `null` (см. `handleAdd`) — незаметно утечь ему некуда.
  const switchProvider = (next: RegistrarProvider) => {
    if (secrets.saving || next === provider) return;
    setProvider(next);
    secrets.reset();
  };

  // Пока идёт запись блобов или POST, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего создания приземлится в пустоту —
  // канала для этой ошибки у страницы нет. Окно — целый round-trip.
  const closeIfIdle = () => { if (!secrets.saving) onClose(); };

  return <Modal title="Add Registrar Account" onClose={closeIfIdle} width={480}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account Name</label><Inp value={accName} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setAccName((e.target as any).value)} placeholder="e.g., Hostiq Main"/></div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:8}}>Provider</label>
        {/* Список, а не две карточки: провайдером может быть любой — у Hostiq и
            Namecheap есть Rust-клиент, остальные заводятся ярлыком. Что уходит
            наружу (ключ каталога против ярлыка) и почему всё тримится — JSDoc
            `ProviderCombobox`. */}
        <ProviderCombobox value={provider} accounts={accounts} disabled={secrets.saving} onChange={switchProvider} />
      </div>
      {/* Поля учётных данных — только у провайдера с рабочим API-клиентом
          (`hasApi`), а не у зашитого имени: ручному ярлыку набирать нечего, его
          ключ никто не прочитает, и лишний блоб был бы секретом, который не
          используется никогда.

          Почему в вебе полей нет вовсе — JSDoc `DesktopOnlyNote`.
          `trim` на вводе: ключ копируют из панели регистратора, и `\n` в
          хвосте иначе зашифруется как часть секрета — «сохранено» и отказ
          API без всякой связи с формой. Client IP с пробелом просто не
          совпадёт с whitelist. */}
      {api ? <>
        {/* Подпись и плейсхолдер — из каталога, а не тернарником по
            `needsClientIp`: Hostiq ждёт email, Namecheap — имя пользователя
            панели, и это свойство провайдера, а не следствие его whitelist'а.
            Совпадение сегодня точное, но случайное (см. `apiUserField`). */}
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User{userField.suffix}</label><Inp value={apiUser} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setApiUser((e.target as any).value)} placeholder={userField.placeholder}/></div>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key</label>
          {isTauri() ? (
            <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiKey", e.target.value.trim())} placeholder={needsClientIp(provider) ? "••••••••" : "••••••••••••••••"}/>
          ) : (
            <DesktopOnlyNote what="Saving secrets" />
          )}
        </div>
        {needsClientIp(provider) && <>
          <div>
            {/* Поле было нарисовано, но ни к чему не подключено: набранный
                IP никуда не уезжал, и аккаунт Namecheap нельзя было
                настроить до конца — десктоп шлёт вместо него 127.0.0.1, а
                Namecheap отвечает отказом по whitelist. */}
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Client IP</label>
            {isTauri() ? (
              <Inp value={secrets.values.apiSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiSecret", e.target.value.trim())} placeholder="127.0.0.1"/>
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
          {/* Провайдер назван меткой из каталога, а не строкой в разметке: поле
              показывается по `needsClientIp`, и второй провайдер с whitelist
              иначе получил бы подпись про Namecheap. */}
          <div style={{fontSize:11.5,color:"#9ca3af",marginTop:-6}}>{providerMeta(provider).label} accepts API calls only from IPs whitelisted in your account.</div>
        </>}
      </> : null}
    </div>
    {secrets.error && (
      <div role="alert" style={{marginTop:14,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{secrets.error}</div>
    )}
    {/* Страница в вебе сюда не пускает (на месте кнопки заметка) — но это
        ПЕРВЫЙ рубеж, а этот последний: он переживёт второго вызывающего.
        Создание живёт только в десктопе и для ручного провайдера тоже: веб
        «только смотрит» (CLAUDE.md §3), и исключение из этого правила по
        признаку «тут нет секретов» разошлось бы с остальными формами.

        Имя аккаунта обязательно: у ручного провайдера оно ЕДИНСТВЕННОЕ, что
        отличает заполненную форму от пустой (секретов, которые отбил бы хук,
        у него нет), и без этой проверки клик заводил бы безымянный ярлык. */}
    {isTauri() && (
      <div style={{display:"flex",gap:8,marginTop:22}}>
        <Btn variant="primary" onClick={handleAdd} disabled={secrets.saving || !accName.trim()} style={{flex:1,justifyContent:"center"}}>{secrets.saving ? "Adding..." : "Add Account"}</Btn>
      </div>
    )}
    {/* Cancel есть всегда (форма обязана иметь выход), но гаснет на время
        сохранения: см. `closeIfIdle`. */}
    <div style={{marginTop:8}}><Btn variant="secondary" disabled={secrets.saving} onClick={closeIfIdle} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
  </Modal>;
}

function EditRegistrarModal({ registrar, onClose }: { registrar: any; onClose: () => void }) {
  const [name, setName] = useState(registrar.name || "");
  const [apiUser, setApiUser] = useState(registrar.api_user || "");
  const secrets = useMultiSecretSave(REGISTRAR_SECRETS);
  const update = useUpdateRegistrarAccount(registrar.id);
  // ВСЁ про провайдера — из одного `providerMeta`, как на карточке: и метка с
  // аватаром в read-only строке, и `m.api`, который решает, показывать ли поля
  // учётных данных. Отдельный вызов `hasApi` рядом был бы вторым ответом на тот
  // же вопрос — на этой ветке такое расхождение уже ловили дважды.
  //
  // Пустой/`null` provider из ответа сервера обе функции принимают сами (см. их
  // сигнатуры) — своей нормализации здесь нет намеренно.
  const m = providerMeta(registrar.provider);
  // Тот же предикат, что у формы создания и у карточки: два ответа на вопрос
  // «нужен ли этому провайдеру Client IP» уже разъезжались (см. Фазу 1 плана).
  // Сам он уже гейтится по `hasApi`, то есть у ручного провайдера всегда false.
  const hasClientIp = needsClientIp(registrar.provider);

  const patch = (blobIds: { apiKey?: string; apiSecret?: string }) => ({
    name: name.trim(),
    // `api_user` уезжает и у ручного провайдера — тем, чем он был в аккаунте
    // (обычно `null`: форма создания у ручного шлёт жёсткий `null`). Жёсткого
    // `null` здесь НЕТ намеренно: поле мы у него не показываем, а «не показываем»
    // значит «не меняем». Достижимое исключение — строка вроде `" hostiq "`
    // (провайдер с пробелами: десктоп такую не знает, значит для нас она ручная)
    // с заполненным `api_user`; отправь мы `null`, переименование аккаунта молча
    // стёрло бы логин, которого пользователю даже не показали. У API-провайдера
    // поле на экране есть, и его значение сохраняется ровно как раньше.
    api_user: apiUser.trim() || null,
    ...(blobIds.apiKey ? { api_key_blob_id: blobIds.apiKey } : {}),
    ...(blobIds.apiSecret ? { api_secret_blob_id: blobIds.apiSecret } : {}),
  });

  const handleSave = async () => {
    // «Оставь пустым, чтобы сохранить текущий» — это и есть `Partial` у
    // `saveAll`: в `secrets` кладём ТОЛЬКО тронутые поля, у остальных сущность
    // сохраняет прежний `*_blob_id`. Иначе переименование аккаунта требовало бы
    // перенабрать и ключ, и IP. Пустой `secrets` (тронуто ничего) — это тоже
    // рабочий путь: блобов нет, `persist` всё равно зовётся, PUT уходит без
    // ссылок; отдельная ветка мимо хука дала бы второй `saving` и второй канал
    // ошибки на ту же кнопку.
    //
    // `trim` здесь решает ровно один вопрос: тронуто ли поле. Без него `"   "`
    // прошёл бы и проверку пустоты в хуке, и запись — рабочий блоб
    // перезаписался бы пробелами, а восстановить его можно только перенабором.
    // Сам плейнтекст он не чистит: в блоб уезжает стейт хука, а не эти
    // тримленные копии, — пробелы по краям с него снимает `trim` в onChange
    // полей ниже, и никакой второй страховки на плейнтекст здесь нет.
    //
    // Каждое поле гейтится ТЕМ ЖЕ предикатом, что решает, рисовать ли его:
    // `m.api` у ключа, `hasClientIp` у IP. Сегодня это дублирует разметку
    // (плейнтекст ненарисованного поля всегда пуст), но держит инвариант
    // «чего не показали — того не пишем» в обработчике, а не в JSX: провайдер в
    // правке неизменяем, и остаточному вводу взяться неоткуда ровно до тех пор,
    // пока это так.
    const touched = {
      apiKey: m.api && secrets.values.apiKey.trim() !== "",
      apiSecret: hasClientIp && secrets.values.apiSecret.trim() !== "",
    };
    const ok = await secrets.saveAll({
      secrets: {
        // Это ПРАВКА: переписываем именно текущие блобы. Новый id оставил бы
        // аккаунт указывать на прежний секрет — «сохранено», а в API
        // регистратора едет старый ключ.
        apiKey: touched.apiKey
          ? { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: registrar.api_key_blob_id ?? null }
          : undefined,
        apiSecret: touched.apiSecret
          ? { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: registrar.api_secret_blob_id ?? null }
          : undefined,
      },
      persist: async (blobIds) => { await update.mutateAsync(patch(blobIds)); },
    });
    if (ok) onClose();
  };

  // Пока идёт запись блобов или PUT, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего сохранения приземлится в пустоту.
  const closeIfIdle = () => { if (!secrets.saving) onClose(); };

  return <Modal title={`Edit ${registrar.name}`} onClose={closeIfIdle} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setName((e.target as any).value)} /></div>
      {/* Провайдер показан, но не редактируется — и это не «поле, которое забыли
          сделать полем». Сменить провайдера у заведённого аккаунта значит
          оставить блобы ключа и IP привязанными к учётке ДРУГОГО регистратора:
          форма отрапортует «сохранено», а команды пойдут в чужой API со старым
          ключом. Провайдер меняют заведением нового аккаунта, а этот — правят
          или удаляют.

          Нарисован тем же аватаром и тем же чипом, что комбобокс на создании и
          карточка, из которой эту модалку открыли: один провайдер обязан
          выглядеть одинаково везде (JSDoc `ProviderVisuals`). Своя разметка
          «метка + Badge» была бы третьим способом рисовать одно различие — ровно
          тем долгом, который закрыт в Фазе 5. Отличие от комбобокса — только
          серый фон и серая метка: так строка читается как «показано», а не
          «нажми меня». */}
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Provider</label>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8}}>
          <ProviderAvatar m={m} />
          <span style={{fontSize:13.5,fontWeight:600,color:"#6b7280"}}><ProviderLabel m={m} /></span>
          <ProviderApiTag api={m.api} />
        </div>
      </div>
      {/* Поля учётных данных — только у провайдера с рабочим API-клиентом, тем же
          гейтом, что и в форме создания: у ручного ярлыка нет ни ключа, ни
          Client IP, и «API Key (optional)» на его правке предлагал бы завести
          секрет, который никто никогда не прочитает. В вебе у API-провайдера на
          месте этих полей стоит заметка (`DesktopOnlyNote`), а у ручного нет и
          её: сказать «секреты сохраняются в десктопе» про аккаунт, у которого
          секретов не бывает, — обещание несуществующей функции.

          Переименовать аккаунт в вебе при этом можно — и ручной, и API-шный:
          для имени секреты не нужны. */}
      {m.api && <>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User</label><Inp value={apiUser} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setApiUser((e.target as any).value)} /></div>
        {/* Почему в вебе полей нет — JSDoc `DesktopOnlyNote`. */}
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key (optional)</label>
          {isTauri() ? (
            <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiKey", e.target.value.trim())} placeholder="Leave empty to keep current key" />
          ) : (
            <DesktopOnlyNote what="Saving secrets" />
          )}
        </div>
        {hasClientIp && (
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Client IP (optional)</label>
            {isTauri() ? (
              <Inp value={secrets.values.apiSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiSecret", e.target.value.trim())} placeholder="Leave empty to keep current IP" />
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
        )}
      </>}
    </div>
    {secrets.error && (
      <div role="alert" style={{marginTop:14,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{secrets.error}</div>
    )}
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={secrets.saving || !name.trim()} onClick={handleSave} style={{flex:1,justifyContent:"center"}}>{secrets.saving ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" disabled={secrets.saving} onClick={closeIfIdle} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
