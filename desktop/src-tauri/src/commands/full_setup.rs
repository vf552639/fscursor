//! Full setup одного домена: зона в Cloudflare + (по флагу) NS у регистратора.
//!
//! Связки (`server_id`, `cloudflare_account_id`, `registrar_id`) к этому моменту
//! уже проставлены бэкендом (`POST /domains/full-setup`): всё, что требует
//! токена, сервер сделать не может и не должен — он видит только шифротекст.
//! Здесь выполняется ровно эта, вторая половина.
//!
//! Команда — на ОДИН домен. Массовость живёт во фронте (пачка гоняет ту же
//! команду с конкуренцией): десктопу тогда не нужно ни второго журнала прогонов,
//! ни своего понятия «частично отработавшая пачка» — отчёт по домену
//! собирается из этих же структур.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::cloudflare::{ensure_zone, AUDIT_ACTION_ZONE_CREATE};
use crate::commands::creds::{cache_path, AUDIT_PROGRESS_EVENT};
use crate::commands::registrars::{registrar_provider, registrar_set_nameservers};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::registrars::supports_ns_api;
use crate::sync::http::{ApiClient, DomainWriteBack};

/// Ключ действия для события о непрошедшем write-back'е ПЕРЕИСПОЛЬЗОВАННОЙ
/// зоны. Пара к `AUDIT_ACTION_ZONE_CREATE`, и разведены они не из педантизма:
/// слушатель на фронте склеивает текст из `AUDIT_ACTION_LABEL` в утвердительном
/// прошедшем времени, поэтому с ключом «create» пользователь прочитал бы «Zone
/// created…» про зону, которую этот же отчёт специально не назвал созданной —
/// ровно на том вопросе, ради которого отчёт и читают («не завёл ли я второй
/// домен в Cloudflare»). Своей строчки в audit log у этого ключа нет: связку
/// домена с зоной пишет бэкенд (`PUT /domains/{id}`), а не десктоп.
const AUDIT_ACTION_ZONE_LINK: &str = "cf.zone.link";

/// Что стало с зоной домена в Cloudflare.
///
/// «Создали» и «уже была» разведены намеренно: повтор full-setup по тому же
/// домену — штатный сценарий (мастер закрыли на середине, пачку перезапустили),
/// и отчёт, называющий переиспользованную зону созданной, врёт ровно там, где
/// пользователь проверяет, не завёл ли он второй домен в Cloudflare.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ZoneStep {
    Created {
        zone_id: String,
        /// NS зоны — то, что надо прописать у регистратора. Пустой список
        /// означает, что Cloudflare их не назвал: пушить нечего.
        name_servers: Vec<String>,
    },
    Existed {
        zone_id: String,
        name_servers: Vec<String>,
    },
    /// Зону не завести и не найти. Текст — для человека, повтор безопасен.
    Failed { error: String },
}

impl ZoneStep {
    fn zone_id(&self) -> Option<&str> {
        match self {
            ZoneStep::Created { zone_id, .. } | ZoneStep::Existed { zone_id, .. } => Some(zone_id),
            ZoneStep::Failed { .. } => None,
        }
    }

    /// Ключ действия для тоста о непрошедшем write-back'е — см.
    /// `AUDIT_ACTION_ZONE_LINK`.
    fn writeback_action(&self) -> &'static str {
        match self {
            ZoneStep::Created { .. } => AUDIT_ACTION_ZONE_CREATE,
            ZoneStep::Existed { .. } | ZoneStep::Failed { .. } => AUDIT_ACTION_ZONE_LINK,
        }
    }

    fn name_servers(&self) -> &[String] {
        match self {
            ZoneStep::Created { name_servers, .. } | ZoneStep::Existed { name_servers, .. } => {
                name_servers
            }
            ZoneStep::Failed { .. } => &[],
        }
    }
}

/// Почему шаг NS не выполнялся. Это НЕ провалы: ни один из случаев не лечится
/// повтором, и в отчёте они обязаны читаться иначе, чем отказ регистратора.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NsSkipReason {
    /// Тумблер «Прописать NS» выключен.
    NotRequested,
    /// Регистратор домену не назначен — некому отдавать команду.
    NoRegistrarAccount,
    /// У провайдера нет API смены NS (`registrars::supports_ns_api`).
    RegistrarNoNsApi,
    /// Зона не заведена: без неё шаг беспредметен.
    ZoneUnavailable,
    /// Зона есть, а NS у неё Cloudflare не назвал — прописывать нечего.
    ZoneWithoutNameservers,
}

/// Что стало с делегированием у регистратора.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NsStep {
    Pushed { nameservers: Vec<String> },
    Skipped { reason: NsSkipReason },
    Failed { error: String },
}

/// Отчёт по одному домену.
///
/// Наружу — именно отчёт, а не `Result`: частичный успех тут обычное дело (зона
/// заведена, NS отбиты регистратором), и `Err` на нём стёр бы половину правды —
/// фронт узнал бы, что «не получилось», но не что зона уже есть и второй раз её
/// создавать не надо.
#[derive(Debug, Serialize)]
pub struct FullSetupOut {
    pub domain_id: String,
    pub zone: ZoneStep,
    /// Уехал ли `cloudflare_zone_id` в строку домена на сервере. `null` — зоны
    /// нет, писать было нечего.
    ///
    /// `false` — самый дорогой из полууспехов: зона в Cloudflare есть, а SDMP о
    /// ней не знает. Поэтому он и виден отдельным полем, а не тонет в `zone`.
    pub zone_saved: Option<bool>,
    pub ns: NsStep,
}

/// Что уезжает в строку домена после шага зоны.
///
/// Только `cloudflare_zone_id`: сервер применяет патч как `exclude_unset`, и
/// любое лишнее поле здесь затёрло бы чужой результат (`ssl_status` от
/// провижининга, `ns_status` от смены NS).
fn zone_write_back_body(zone_id: &str) -> DomainWriteBack {
    DomainWriteBack {
        cloudflare_zone_id: Some(zone_id.to_string()),
        ..Default::default()
    }
}

/// Решение по шагу NS, принимаемое ДО обращения к регистратору.
///
/// Чистая функция, потому что иначе эти ветки не покрыть вовсе: за каждой из
/// них стоит `State`/`AppHandle`, а цена ошибки — молчаливо пропущенный шаг,
/// который в отчёте выглядит как решение, а не как забытая работа.
#[derive(Debug, PartialEq, Eq)]
enum NsPlan<'a> {
    Push {
        account_id: &'a str,
        nameservers: Vec<String>,
    },
    Skip(NsSkipReason),
}

fn ns_plan<'a>(
    push_ns: bool,
    registrar_account_id: Option<&'a str>,
    zone: &ZoneStep,
) -> NsPlan<'a> {
    if !push_ns {
        return NsPlan::Skip(NsSkipReason::NotRequested);
    }
    // Порядок проверок — от «пользователь так решил» к «нечем работать»:
    // выключенный тумблер объясняет пропуск полностью, и рассказывать поверх
    // него про отсутствующую зону значило бы называть причиной то, что причиной
    // не было.
    let Some(account_id) = registrar_account_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return NsPlan::Skip(NsSkipReason::NoRegistrarAccount);
    };
    if zone.zone_id().is_none() {
        return NsPlan::Skip(NsSkipReason::ZoneUnavailable);
    }
    let nameservers: Vec<String> = zone.name_servers().to_vec();
    if nameservers.is_empty() {
        return NsPlan::Skip(NsSkipReason::ZoneWithoutNameservers);
    }
    NsPlan::Push {
        account_id,
        nameservers,
    }
}

/// Ответ регистратора «команду принял, а менять не стал». Константа, потому что
/// это текст на экране пользователя, а не деталь реализации.
const NS_NOT_APPLIED: &str = "the registrar did not apply the nameserver change";

/// Идти ли к регистратору, зная его провайдера. `None` — идти.
///
/// Отдельной чистой функцией по образцу `ns_outcome_plan` в
/// `commands::registrars`: за живым вызовом стоят `State` и keychain, то есть
/// иначе гейт не покрыть вовсе — его можно было бы снять, и все тесты остались
/// бы зелёными. А цена в том, что «нет API» и «сломалось» — разные новости:
/// первая не лечится повтором, вторая лечится.
///
/// Проверка живёт в десктопе, а не только во фронте: тумблер там — про UX, а
/// правду о том, что десктоп умеет, знает `make_service`. Пойди мы к
/// регистратору без неё, в отчёте стояло бы красное «unknown provider:
/// godaddy» — предложение чинить то, что чинится только руками в панели.
fn ns_gate_by_provider(provider: &Result<String, CommandError>) -> Option<NsStep> {
    match provider {
        Err(e) => Some(NsStep::Failed {
            error: e.to_string(),
        }),
        Ok(p) if !supports_ns_api(p) => Some(NsStep::Skipped {
            reason: NsSkipReason::RegistrarNoNsApi,
        }),
        Ok(_) => None,
    }
}

/// Итог обращения к регистратору — в строку отчёта.
fn ns_step_of(outcome: Result<bool, CommandError>, nameservers: Vec<String>) -> NsStep {
    match outcome {
        Ok(true) => NsStep::Pushed { nameservers },
        // Сегодня недостижимо (обе реализации отвечают `Ok(true)` или ошибкой),
        // но семантика у `Ok(false)` та же «не применил», и зелёным он быть не
        // может: `ns_status` этот же случай уже записал как `error`.
        Ok(false) => NsStep::Failed {
            error: NS_NOT_APPLIED.into(),
        },
        Err(e) => NsStep::Failed {
            error: e.to_string(),
        },
    }
}

/// Прописать NS у регистратора — если он это умеет.
#[allow(clippy::too_many_arguments)]
async fn push_nameservers(
    app: &AppHandle,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    api: &State<'_, ApiClient>,
    account_id: &str,
    domain_id: &str,
    domain_name: &str,
    nameservers: Vec<String>,
) -> NsStep {
    if let Some(step) = ns_gate_by_provider(&registrar_provider(user_id, handle, account_id)) {
        return step;
    }

    // Зовём соседнюю команду целиком, а не трейт регистратора: вместе со сменой
    // NS она пишет `ns_status` в строку домена и строчку `registrar.ns_set` в
    // audit log. Повторив здесь только вызов трейта, full-setup оставлял бы
    // домен с вечным `pending` на бейдже делегирования.
    let outcome = registrar_set_nameservers(
        app.clone(),
        user_id.to_string(),
        account_id.to_string(),
        domain_id.to_string(),
        domain_name.to_string(),
        nameservers.clone(),
        handle.clone(),
        api.clone(),
    )
    .await;
    ns_step_of(outcome, nameservers)
}

/// Записать `cloudflare_zone_id` в строку домена. Возвращает, получилось ли;
/// `None` — зоны нет, писать было нечего.
///
/// Best-effort по той же причине, что и аудит: зона в Cloudflare к этому моменту
/// уже есть, откату не подлежит, и `?` здесь превратил бы её создание в
/// «не получилось» — пользователь пошёл бы заводить вторую. Но не молча:
/// провал виден и в отчёте (`zone_saved: false`), и тостом.
async fn save_zone_id(
    app: &AppHandle,
    api: &ApiClient,
    domain_id: &str,
    domain_name: &str,
    zone: &ZoneStep,
) -> Option<bool> {
    let zone_id = zone.zone_id()?;
    if let Err(e) = api
        .domain_write_back(domain_id, &zone_write_back_body(zone_id))
        .await
    {
        tracing::warn!(target: "full_setup", "write-back of cloudflare_zone_id failed: {e}");
        // Слушатель на той стороне склеивает текст из `AUDIT_ACTION_LABEL` в
        // утвердительном прошедшем времени, поэтому ключ действия зависит от
        // того, создавали мы зону или взяли готовую (`writeback_action`).
        let _ = app.emit(
            AUDIT_PROGRESS_EVENT,
            serde_json::json!({
                "step": "writeback_failed",
                "action": zone.writeback_action(),
                "target_type": "domain",
                "target_id": domain_name,
            }),
        );
        return Some(false);
    }
    Some(true)
}

/// Есть ли десктопу чем работать вообще.
///
/// Условия здесь не про домен, а про машину: запертый сейф и неинициализированная
/// синхронизация одинаковы для всех ста доменов пачки. Отдав их отчётом, мы дали
/// бы фронту сто одинаковых красных строк, неотличимых от отказа Cloudflare по
/// конкретному домену, и сто попыток открыть keychain вместо одного громкого
/// «сейф заперт». Поэтому — `Err`, до единого сетевого запроса и до любых
/// изменений: у вызывающего это единственный однозначный сигнал «останови
/// прогон» (отличать `Failed`-строки по префиксу `keychain: ` он не обязан —
/// это формат `thiserror`, а не контракт).
fn preflight(user_id: &str, handle: &State<'_, SyncHandle>) -> Result<(), CommandError> {
    cache_path(handle)?;
    let mut key = keychain::load_vault_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    // Ключ нужен был только как ответ на «сейф открыт?»: работать им будут
    // шаги, каждый со своей копией.
    key.zeroize();
    Ok(())
}

/// Завести домен в Cloudflare и (по флагу) прописать его NS у регистратора.
///
/// `domain_name` приходит аргументом, а не читается из локального кэша: домен
/// мог быть создан секунду назад мастером «Add Domain», и до следующей
/// синхронизации его строки в кэше нет вовсе. `domain_id` — адресат write-back'а,
/// одно из другого не выводится, поэтому приходят оба.
///
/// `Err` означает ровно одно: работа НЕ начиналась и повторять её по этому
/// домену бессмысленно, пока не починено общее — бессмысленный ввод либо
/// условие уровня машины (`preflight`). Всё, что случилось с провайдерами, —
/// это отчёт (см. `FullSetupOut`). Для пачки это и есть граница: `Err` —
/// «останови прогон», `Ok` — «строка отчёта, иди дальше».
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn domain_full_setup(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    domain_name: String,
    cloudflare_account_id: String,
    registrar_account_id: Option<String>,
    push_ns: bool,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<FullSetupOut, CommandError> {
    let domain_name = domain_name.trim();
    if domain_name.is_empty() {
        return Err(CommandError::Api("domain name is empty".into()));
    }
    if cloudflare_account_id.trim().is_empty() {
        return Err(CommandError::Api("cloudflare account id is empty".into()));
    }
    preflight(&user_id, &handle)?;

    let zone = match ensure_zone(
        &app,
        &api,
        &user_id,
        &handle,
        cloudflare_account_id.trim(),
        domain_name,
    )
    .await
    {
        Ok((zone, true)) => ZoneStep::Created {
            zone_id: zone.id,
            name_servers: zone.name_servers.unwrap_or_default(),
        },
        Ok((zone, false)) => ZoneStep::Existed {
            zone_id: zone.id,
            name_servers: zone.name_servers.unwrap_or_default(),
        },
        // Сейф успели запереть между `preflight` и этим вызовом (или его
        // перезаперли из другого окна): условие снова общее для всей пачки, и
        // строкой отчёта оно быть не должно — гнать за ним ещё девяносто девять
        // доменов незачем.
        Err(e @ CommandError::Keychain(_)) => return Err(e),
        Err(e) => ZoneStep::Failed {
            error: e.to_string(),
        },
    };

    // Write-back раньше NS — как в провижининге: шаг NS уходит в сеть надолго,
    // а идентификатор зоны на сервере нужен независимо от того, чем он там
    // кончится.
    let zone_saved = save_zone_id(&app, &api, &domain_id, domain_name, &zone).await;

    let ns = match ns_plan(push_ns, registrar_account_id.as_deref(), &zone) {
        NsPlan::Skip(reason) => NsStep::Skipped { reason },
        NsPlan::Push {
            account_id,
            nameservers,
        } => {
            push_nameservers(
                &app,
                &user_id,
                &handle,
                &api,
                account_id,
                &domain_id,
                domain_name,
                nameservers,
            )
            .await
        }
    };

    Ok(FullSetupOut {
        domain_id,
        zone,
        zone_saved,
        ns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone_ok() -> ZoneStep {
        ZoneStep::Created {
            zone_id: "z1".into(),
            name_servers: vec![
                "ada.ns.cloudflare.com".into(),
                "bob.ns.cloudflare.com".into(),
            ],
        }
    }

    #[test]
    fn zone_write_back_touches_nothing_but_the_zone_id() {
        // Патч применяется как `exclude_unset`: лишнее поле затёрло бы чужой
        // результат — `ssl_status` провижининга или `ns_status` смены NS,
        // которая идёт следующим шагом этой же команды.
        assert_eq!(
            serde_json::to_string(&zone_write_back_body("z1")).unwrap(),
            r#"{"cloudflare_zone_id":"z1"}"#
        );
    }

    #[test]
    fn ns_is_skipped_when_the_toggle_is_off() {
        // Даже с зоной и регистратором на руках: выключенный тумблер — это
        // решение пользователя, а не нехватка данных.
        assert_eq!(
            ns_plan(false, Some("7"), &zone_ok()),
            NsPlan::Skip(NsSkipReason::NotRequested)
        );
    }

    #[test]
    fn ns_is_skipped_without_a_registrar_account() {
        assert_eq!(
            ns_plan(true, None, &zone_ok()),
            NsPlan::Skip(NsSkipReason::NoRegistrarAccount)
        );
        // Пустая строка приезжает из формы так же легко, как `null`, и «отдать
        // команду аккаунту с пустым id» — не то, что стоит пробовать.
        assert_eq!(
            ns_plan(true, Some("  "), &zone_ok()),
            NsPlan::Skip(NsSkipReason::NoRegistrarAccount)
        );
    }

    fn zone_failed() -> ZoneStep {
        ZoneStep::Failed {
            error: "cloudflare api: [{\"code\":1061}]".into(),
        }
    }

    #[test]
    fn ns_is_skipped_when_the_zone_step_failed() {
        // Частичный успех наоборот: зона не вышла, и шаг NS не «провалился», а
        // не выполнялся — иначе отчёт показал бы две красных строки об одной
        // неудаче.
        assert_eq!(
            ns_plan(true, Some("7"), &zone_failed()),
            NsPlan::Skip(NsSkipReason::ZoneUnavailable)
        );
    }

    /// Причин пропуска несколько, и верны они бывают одновременно — тогда
    /// названа должна быть первая по порядку, иначе пользователь чинит не то.
    /// Порядок держится ЭТИМ тестом: комментарий рядом с функцией переставить
    /// проверки не мешает.
    #[test]
    fn ns_skip_reasons_are_ranked_and_the_first_true_one_wins() {
        // Не так вообще всё: тумблер выключен, регистратора нет, зоны нет.
        // Названо решение пользователя — остальное он и не просил.
        assert_eq!(
            ns_plan(false, None, &zone_failed()),
            NsPlan::Skip(NsSkipReason::NotRequested)
        );
        // Тумблер включён; регистратора нет И зоны нет. Регистратор ближе к
        // тому, что пользователь настраивает сам, — и он же нужен даже с
        // удавшейся зоной.
        assert_eq!(
            ns_plan(true, None, &zone_failed()),
            NsPlan::Skip(NsSkipReason::NoRegistrarAccount)
        );
        // Регистратор есть; зоны нет — а раз нет зоны, то нет и её NS.
        // «Зона не вышла» объясняет пропуск, «у зоны нет NS» — врёт про зону,
        // которой не существует.
        assert_eq!(
            ns_plan(true, Some("7"), &zone_failed()),
            NsPlan::Skip(NsSkipReason::ZoneUnavailable)
        );
    }

    #[test]
    fn ns_is_skipped_when_the_zone_named_no_nameservers() {
        let bare = ZoneStep::Existed {
            zone_id: "z1".into(),
            name_servers: vec![],
        };
        assert_eq!(
            ns_plan(true, Some("7"), &bare),
            NsPlan::Skip(NsSkipReason::ZoneWithoutNameservers)
        );
    }

    #[test]
    fn ns_pushes_the_nameservers_of_the_zone() {
        assert_eq!(
            ns_plan(true, Some(" 7 "), &zone_ok()),
            NsPlan::Push {
                account_id: "7",
                nameservers: vec![
                    "ada.ns.cloudflare.com".into(),
                    "bob.ns.cloudflare.com".into()
                ],
            }
        );
    }

    #[test]
    fn provider_without_ns_api_is_a_skip_and_not_a_failure() {
        // «Нет API» повтором не лечится, а красная строка предлагала бы чинить
        // то, что чинится только руками в панели регистратора.
        assert_eq!(
            ns_gate_by_provider(&Ok("godaddy".into())),
            Some(NsStep::Skipped {
                reason: NsSkipReason::RegistrarNoNsApi
            })
        );
        // Регистр — единственное, что схлопывается (как в `make_service`).
        assert_eq!(ns_gate_by_provider(&Ok("Namecheap".into())), None);
        assert_eq!(ns_gate_by_provider(&Ok("hostiq".into())), None);
    }

    #[test]
    fn unreadable_registrar_account_is_a_failure_and_not_a_skip() {
        // Обратная сторона: аккаунт есть, но прочитать его не вышло — это сбой,
        // и повтор (после синхронизации) его как раз лечит. Пропуском он
        // выглядел бы как принятое решение не менять NS.
        assert_eq!(
            ns_gate_by_provider(&Err(CommandError::Api(
                "registrar account not in local cache".into()
            ))),
            Some(NsStep::Failed {
                error: "api: registrar account not in local cache".into()
            })
        );
    }

    #[test]
    fn ns_outcome_becomes_a_report_line() {
        let ns = || vec!["ada.ns.cloudflare.com".into()];
        assert_eq!(
            ns_step_of(Ok(true), ns()),
            NsStep::Pushed { nameservers: ns() }
        );
        // Отказ регистратора уезжает текстом как есть: он уже вычищен от
        // секретов на своей стороне (`namecheap::scrub`).
        assert_eq!(
            ns_step_of(
                Err(CommandError::Api(
                    "Namecheap error: Invalid nameserver".into()
                )),
                ns()
            ),
            NsStep::Failed {
                error: "api: Namecheap error: Invalid nameserver".into()
            }
        );
        // `Ok(false)` сегодня недостижим, но зелёным он быть не может: тот же
        // случай `ns_status` уже записал как `error`.
        assert_eq!(
            ns_step_of(Ok(false), ns()),
            NsStep::Failed {
                error: NS_NOT_APPLIED.into()
            }
        );
    }

    /// Тост о непрошедшем write-back'е произносится в утвердительном прошедшем
    /// времени, поэтому ключ действия обязан следовать за тем, что команда
    /// сказала в отчёте: «Zone created» про переиспользованную зону — ровно та
    /// неточность, из-за которой пользователь пойдёт искать второй домен в
    /// Cloudflare.
    #[test]
    fn writeback_toast_speaks_of_creation_only_when_the_zone_was_created() {
        assert_eq!(zone_ok().writeback_action(), "cf.zone.create");
        assert_eq!(
            ZoneStep::Existed {
                zone_id: "z1".into(),
                name_servers: vec![],
            }
            .writeback_action(),
            "cf.zone.link"
        );
    }

    /// Форма отчёта — контракт с фронтом (по нему собирается сводка пачки).
    /// Ожидания литеральные: пересчитай их тем же кодом — и переименованный
    /// вариант перестанет что-либо ломать.
    #[test]
    fn report_of_a_full_run_names_every_step() {
        let out = FullSetupOut {
            domain_id: "42".into(),
            zone: zone_ok(),
            zone_saved: Some(true),
            ns: NsStep::Pushed {
                nameservers: vec!["ada.ns.cloudflare.com".into()],
            },
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({
                "domain_id": "42",
                "zone": {
                    "status": "created",
                    "zone_id": "z1",
                    "name_servers": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
                },
                "zone_saved": true,
                "ns": {"status": "pushed", "nameservers": ["ada.ns.cloudflare.com"]},
            })
        );
    }

    #[test]
    fn report_of_a_zone_failure_carries_the_reason_and_no_zone_saved() {
        let out = FullSetupOut {
            domain_id: "42".into(),
            zone: ZoneStep::Failed {
                error: "cloudflare api: token expired".into(),
            },
            zone_saved: None,
            ns: NsStep::Skipped {
                reason: NsSkipReason::ZoneUnavailable,
            },
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({
                "domain_id": "42",
                "zone": {"status": "failed", "error": "cloudflare api: token expired"},
                // Именно `null`, а не `false`: записать было нечего, и это не
                // то же самое, что «записать не удалось».
                "zone_saved": null,
                "ns": {"status": "skipped", "reason": "zone_unavailable"},
            })
        );
    }

    /// Полууспех, ради которого отчёт и заведён: зона есть, делегирование —
    /// нет. Ни `Err`, ни зелёная галочка это не описывают.
    #[test]
    fn report_of_a_partial_run_keeps_the_zone_and_names_the_ns_failure() {
        let out = FullSetupOut {
            domain_id: "42".into(),
            zone: ZoneStep::Existed {
                zone_id: "z1".into(),
                name_servers: vec!["ada.ns.cloudflare.com".into()],
            },
            zone_saved: Some(false),
            ns: NsStep::Failed {
                error: "api: Namecheap error: Invalid nameserver".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            serde_json::json!({
                "domain_id": "42",
                "zone": {
                    "status": "existed",
                    "zone_id": "z1",
                    "name_servers": ["ada.ns.cloudflare.com"],
                },
                "zone_saved": false,
                "ns": {"status": "failed", "error": "api: Namecheap error: Invalid nameserver"},
            })
        );
    }
}
