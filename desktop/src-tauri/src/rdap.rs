//! RDAP — куда домен делегирован ПО ДАННЫМ РЕЕСТРА.
//!
//! Единственный в проекте способ прочитать nameservers домена извне
//! регистратора. До него их не знал никто: у Hostiq чтения NS в API нет вовсе
//! (в `domain/list` нет такого поля — проверено на всех 127 доменах боевого
//! аккаунта), у ручных провайдеров вроде Dynadot API нет в принципе, — то есть
//! бейдж делегирования у большинства доменов был обречён оставаться серым.
//!
//! RDAP отвечает не на тот вопрос, на который отвечает DNS, и разница здесь
//! существенная. Живая проверка на `betify2.com`: реестр вернул
//! `ADA.NS.CLOUDFLARE.COM` / `BOB.NS.CLOUDFLARE.COM` при том, что зона не
//! обслуживается и рекурсивный резолвер отвечает SERVFAIL (`EDE(22): No
//! Reachable Authority`). То есть RDAP говорит «куда домен делегирован», а не
//! «отвечает ли зона», — и бейджу делегирования нужно именно первое. Резолвер на
//! этом домене нарисовал бы «NS не найдены», что неправда.
//!
//! ## Почему `rdap.org`, а не IANA bootstrap — осознанный компромисс
//!
//! `rdap.org` — сторонний редиректор: он принимает запрос, смотрит на TLD и
//! отправляет 30x на RDAP-сервер нужного реестра. Значит, ИМЕНА НАШИХ ДОМЕНОВ
//! видит третья сторона. Zero-knowledge это не нарушает (имя домена секретом не
//! является — оно и так публично в реестре, и сервер SDMP хранит его открытым
//! текстом), но посредник в цепочке — факт, который лучше знать заранее, чем
//! обнаружить.
//!
//! Прямой путь без посредника есть: IANA bootstrap (`data.iana.org/rdap/dns.json`)
//! — официальная карта «TLD → RDAP-сервер», по которой можно ходить в реестр
//! напрямую. Мы его НЕ взяли на старте по одной причине: он покрывает не все
//! нужные нам зоны. В частности `.ua` в bootstrap отсутствует, а `rdap.org` его
//! отдаёт (проверено: `.com`, `.ua`, `.com.br` — все 200). Начать с bootstrap
//! означало бы получить «запросить не удалось» на украинских доменах — то есть
//! ровно там, где у нас регистратор без чтения NS.
//!
//! Поэтому: старт с `rdap.org`, bootstrap — в «осталось». Если однажды он
//! появится, менять придётся только адрес и способ его выбора; форма ответа
//! (`RegistryNameservers`) от этого не зависит.

use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;

use crate::registrars::normalize_ns;

/// Редиректор RDAP. См. разбор про посредника в докстринге модуля.
const RDAP_REDIRECTOR: &str = "https://rdap.org";

/// Медиатип RDAP. Не украшение: часть серверов реестров на `Accept:
/// application/json` отдаёт свою HTML-страницу вместо JSON, и ответ выглядел бы
/// «нераспознанным», хотя данные у сервера есть.
const RDAP_MEDIA_TYPE: &str = "application/rdap+json";

/// Бюджет одного запроса. Он покрывает ВСЮ цепочку с редиректами, а не один
/// хоп: реестры бывают медленными, но карточка домена ждать минуту не может.
const RDAP_TIMEOUT: Duration = Duration::from_secs(15);

/// Сколько редиректов пройти. Не ноль и не «по умолчанию, авось хватит»:
/// `rdap.org` работает ТОЛЬКО редиректом, и клиент, который их не ходит, вернул
/// бы 302 с пустым телом — то есть «запросить не удалось» на каждом домене.
/// Пять — с запасом на цепочку «редиректор → реестр → канонический адрес
/// реестра», но не бесконечность.
const RDAP_MAX_REDIRECTS: usize = 5;

/// Что реестр сказал про делегирование домена.
///
/// Три состояния, а не «список или ошибка», и это ядро модуля. Правило проекта
/// «не рисуй незнание здоровьем» (CLAUDE.md п. 6, `lib/serverStatus.ts`) здесь
/// работает в обе стороны: пустой список нельзя показывать как «NS не
/// прописаны», если мы просто не смогли спросить, — а «не смогли спросить»
/// нельзя показывать как «домена нет в реестре».
///
/// Различать их обязан ВЫЗЫВАЮЩИЙ, потому что чинятся они по-разному:
/// `Registered` с пустым списком — пойти прописать NS у регистратора;
/// `NotRegistered` — домен просрочен или заведён в SDMP опечаткой, регистратор
/// тут ни при чём; `Unavailable` — повторить позже, с делегированием всё может
/// быть в порядке. Слитые в `Result<Vec<String>, _>` два последних случая
/// неотличимы, а первый неотличим от третьего.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegistryNameservers {
    /// Реестр ответил про этот домен. Список МОЖЕТ быть пуст — это не сбой, а
    /// содержательный ответ «домен зарегистрирован, но никуда не делегирован»
    /// (RDAP в таком случае просто не кладёт `nameservers` в ответ).
    Registered { nameservers: Vec<String> },
    /// Домена в реестре нет (RDAP отвечает 404). Отдельно от «не смогли
    /// спросить»: это утверждение реестра, а не наша неудача.
    NotRegistered,
    /// Спросить не удалось: сети нет, реестр молчит, TLD не покрыт редиректором,
    /// ответ не разобрать. Про делегирование мы в этом случае не знаем НИЧЕГО.
    Unavailable { reason: String },
}

/// Клиент RDAP.
pub struct RdapClient {
    /// Адрес RDAP-редиректора. Поле, а не константа, — тем же приёмом и по той
    /// же нужде, что у `registrars::hostiq`/`namecheap`: проверять надо не
    /// разбор в отдельной функции, а то, что живой путь ответа зовёт именно её
    /// и что запрос уходит с нужным заголовком.
    base_url: String,
    client: Client,
}

impl RdapClient {
    pub fn new() -> Self {
        Self::with_base_url(RDAP_REDIRECTOR)
    }

    fn with_base_url(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            client: Client::builder()
                .timeout(RDAP_TIMEOUT)
                // Редиректы объявлены явно, хотя таково и умолчание reqwest:
                // без них этот модуль не работает вовсе (см. `RDAP_MAX_REDIRECTS`),
                // и строка тут стоит, чтобы никто не выключил их «за
                // ненадобностью», скопировав билдер от соседа.
                .redirect(Policy::limited(RDAP_MAX_REDIRECTS))
                .build()
                .expect("reqwest"),
        }
    }

    /// Nameservers домена по данным реестра.
    ///
    /// Не `Result`: неудача запроса — это `Unavailable`, полноправный исход
    /// наравне с остальными двумя, а не ошибка команды. Разверни мы её в `Err`,
    /// вызывающий снова оказался бы перед выбором «пусто или упало», ради
    /// избавления от которого модуль и написан.
    pub async fn nameservers(&self, domain: &str) -> RegistryNameservers {
        // Тот же нормализатор, что и для имён NS, и по той же причине, по
        // которой его зовёт `hostiq::domain_id`: регистр и завершающая точка не
        // должны решать, найдётся домен или нет. Второго нормализатора в
        // десктопе нет намеренно (см. `registrars::normalize_ns`).
        let name = normalize_ns(domain);
        if name.is_empty() {
            // Без сети: `GET /domain/` — это запрос не про домен, и 404 на него
            // соврал бы «домена нет в реестре» про домен, о котором мы даже не
            // спросили.
            return RegistryNameservers::Unavailable {
                reason: "empty domain name".into(),
            };
        }

        // Адрес разбирается заранее, а не отдаётся строкой в `get`, потому что
        // он нужен нам ПОСЛЕ ответа: по нему отличается 404 реестра от 404
        // редиректора (см. ниже).
        let requested = match Url::parse(&format!(
            "{}/domain/{}",
            self.base_url.trim_end_matches('/'),
            name
        )) {
            Ok(u) => u,
            Err(e) => {
                return RegistryNameservers::Unavailable {
                    reason: e.to_string(),
                }
            }
        };
        let resp = match self
            .client
            .get(requested.clone())
            .header(ACCEPT, RDAP_MEDIA_TYPE)
            .send()
            .await
        {
            Ok(r) => r,
            // Текст ошибки reqwest дописывает адрес сам, и здесь это безопасно:
            // в URL нет ничего, кроме имени домена, — ни ключей, ни токенов.
            // (У `namecheap::transport_err` адрес вычищается ровно потому, что
            // там в query-строке едет credential; разница не в стиле.)
            Err(e) => {
                return RegistryNameservers::Unavailable {
                    reason: e.to_string(),
                }
            }
        };

        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            // 404 у RDAP бывает ДВУХ РАЗНЫХ сортов, и путать их нельзя.
            //
            // Реестр отвечает 404 на домен, которого у него нет, — это
            // `NotRegistered`. Но и сам `rdap.org` отвечает 404, когда не знает
            // RDAP-сервера для этого TLD, — и это уже «спросить не удалось»: про
            // делегирование домена такой ответ не говорит ничего. Проверено
            // живьём: `nosuchdomain-zzz9988.com` даёт 404 ПОСЛЕ редиректа на
            // `rdap.verisign.com`, а `example.invalidtldxyz` — 404 без единого
            // редиректа, прямо от `rdap.org`.
            //
            // Различаем по адресу ответа: редирект случился — отвечал реестр, не
            // случился — отвечал редиректор. Прямая проверка «мы всё ещё на
            // редиректоре», а не подсчёт хопов, — потому что именно это и есть
            // вопрос. Уйдёт посредник (IANA bootstrap, см. докстринг модуля) —
            // это место придётся пересмотреть: там мы будем сразу на реестре, и
            // всякий 404 станет честным `NotRegistered`.
            return if resp.url() == &requested {
                RegistryNameservers::Unavailable {
                    reason: "no RDAP service is published for this TLD".into(),
                }
            } else {
                RegistryNameservers::NotRegistered
            };
        }
        if !status.is_success() {
            // Тело сюда НЕ попадает — тем же приёмом и по той же причине, что у
            // `hostiq::failure_text`: текст видит пользователь в карточке
            // домена, а ответ мог прийти не от реестра (заглушка прокси, WAF,
            // капча), и такому в интерфейсе не место.
            return RegistryNameservers::Unavailable {
                reason: format!("registry RDAP returned HTTP {status}"),
            };
        }

        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                return RegistryNameservers::Unavailable {
                    reason: e.to_string(),
                }
            }
        };
        match nameservers_of(&text) {
            Some(nameservers) => RegistryNameservers::Registered { nameservers },
            None => RegistryNameservers::Unavailable {
                reason: "registry RDAP returned a body that is not an RDAP object".into(),
            },
        }
    }
}

/// Имена nameservers из тела ответа RDAP; `None` — тело вообще не похоже на
/// ответ RDAP.
///
/// Разница между `Some(vec![])` и `None` здесь — это и есть разница между
/// `Registered` без делегирования и `Unavailable`, поэтому она стоит отдельного
/// слова. Ответ 200 без ключа `nameservers` — нормальная форма RDAP для
/// зарегистрированного, но не делегированного домена, и звать её сбоем нельзя.
///
/// Признак «похоже на RDAP» намеренно слабый — «это JSON-объект», а не наличие
/// `objectClassName`. RDAP-серверов реестров десятки, и каждый вольничает с
/// необязательными полями; строгая проверка выбрасывала бы валидные ответы
/// целиком. Единственное, что встречается в жизни вместо JSON, — HTML-заглушка
/// посредника, и её этого правила хватает отсечь.
fn nameservers_of(body: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let object = value.as_object()?;
    let Some(items) = object.get("nameservers").and_then(|n| n.as_array()) else {
        return Some(Vec::new());
    };
    Some(
        items
            .iter()
            .filter_map(|ns| {
                // `ldhName` — ASCII-форма имени; реестры пишут её то в верхнем
                // регистре, то с завершающей точкой. Нормализуем тем же
                // выражением, что и всё остальное: список отсюда сравнивается с
                // списком зоны Cloudflare, и разъехавшиеся правила дали бы
                // «расходится» на верном делегировании.
                let host = normalize_ns(ns.get("ldhName")?.as_str()?);
                (!host.is_empty()).then_some(host)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Закрытый порт: любая попытка сходить в сеть отсюда провалится и будет
    /// отличима от ожидаемой ошибки по тексту.
    const NOWHERE: &str = "http://127.0.0.1:1";

    fn rdap_domain(nameservers: Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objectClassName": "domain",
            "ldhName": "betify2.com",
            "nameservers": nameservers,
        }))
    }

    /// Живой путь целиком: ответ реестра → нормализованный список. Регистр и
    /// завершающая точка приходят ровно в той форме, в какой их отдал боевой
    /// RDAP по `betify2.com`, — иначе сравнение с зоной Cloudflare показывало бы
    /// «расходится» на верном делегировании.
    #[tokio::test]
    async fn a_registry_answer_becomes_normalised_nameservers() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(rdap_domain(serde_json::json!([
                {"ldhName": "ADA.NS.CLOUDFLARE.COM."},
                {"ldhName": " bob.ns.cloudflare.com "}
            ])))
            .mount(&srv)
            .await;

        // Имя домена нормализуется по дороге: в реестр уходит `betify2.com`, а
        // не то, как его записали в карточке.
        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("Betify2.COM.")
            .await;

        assert_eq!(
            got,
            RegistryNameservers::Registered {
                nameservers: vec![
                    "ada.ns.cloudflare.com".to_string(),
                    "bob.ns.cloudflare.com".to_string(),
                ]
            }
        );
    }

    /// Заголовок держится матчером живого запроса, а не чтением кода: без
    /// `application/rdap+json` часть реестров отдаёт HTML вместо JSON, и модуль
    /// тихо съезжал бы в «не разобрали ответ» на настоящих доменах.
    #[tokio::test]
    async fn the_request_asks_for_rdap_json() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .and(header("Accept", RDAP_MEDIA_TYPE))
            .respond_with(rdap_domain(serde_json::json!([])))
            .mount(&srv)
            .await;

        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("betify2.com")
            .await;

        // Мок отвечает только на запрос с нужным `Accept`; без него wiremock
        // вернул бы 404, а он у нас значит «домена нет в реестре».
        assert!(
            matches!(got, RegistryNameservers::Registered { .. }),
            "{got:?}"
        );
    }

    /// `rdap.org` — редиректор и ничего кроме: сам он данных не отдаёт. Клиент,
    /// не ходящий редиректы, вернул бы «запросить не удалось» на КАЖДОМ домене,
    /// и тест на 200-ответ этого бы не заметил.
    #[tokio::test]
    async fn redirects_are_followed_all_the_way_to_the_registry() {
        let registry = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .and(header("Accept", RDAP_MEDIA_TYPE))
            .respond_with(rdap_domain(serde_json::json!([
                {"ldhName": "ada.ns.cloudflare.com"}
            ])))
            .mount(&registry)
            .await;

        let redirector = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(ResponseTemplate::new(302).insert_header(
                "location",
                format!("{}/domain/betify2.com", registry.uri()).as_str(),
            ))
            .mount(&redirector)
            .await;

        let got = RdapClient::with_base_url(&redirector.uri())
            .nameservers("betify2.com")
            .await;

        assert_eq!(
            got,
            RegistryNameservers::Registered {
                nameservers: vec!["ada.ns.cloudflare.com".to_string()]
            }
        );
    }

    /// 200 без ключа `nameservers` — родная форма RDAP для домена, который
    /// зарегистрирован, но никуда не делегирован. Это ответ, а не сбой: чинится
    /// он «прописать NS», и путать его с «спросить не удалось» нельзя.
    #[tokio::test]
    async fn a_domain_with_no_delegation_is_still_an_answer() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objectClassName": "domain",
                "ldhName": "betify2.com"
            })))
            .mount(&srv)
            .await;

        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("betify2.com")
            .await;

        assert_eq!(
            got,
            RegistryNameservers::Registered {
                nameservers: vec![]
            }
        );
    }

    /// 404 ОТ РЕЕСТРА — утверждение «такого домена нет», а не наша неудача.
    /// Отдельным состоянием, потому что чинится оно не повтором запроса, а
    /// разбирательством с самим доменом (просрочен, опечатка в карточке).
    /// Редирект в тесте не декорация: он и есть признак, что отвечал реестр.
    #[tokio::test]
    async fn a_domain_missing_from_the_registry_is_its_own_state() {
        let registry = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/missing.com"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "errorCode": 404, "title": "Not Found"
            })))
            .mount(&registry)
            .await;

        let redirector = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/missing.com"))
            .respond_with(ResponseTemplate::new(302).insert_header(
                "location",
                format!("{}/domain/missing.com", registry.uri()).as_str(),
            ))
            .mount(&redirector)
            .await;

        let got = RdapClient::with_base_url(&redirector.uri())
            .nameservers("missing.com")
            .await;

        assert_eq!(got, RegistryNameservers::NotRegistered);
    }

    /// А 404 ОТ РЕДИРЕКТОРА — совсем другое: так `rdap.org` отвечает про TLD, у
    /// которого он не знает RDAP-сервера. Про сам домен это не говорит ничего, и
    /// зачесть его как «домена нет в реестре» значило бы объявить чужой пробел в
    /// покрытии приговором нашему домену.
    ///
    /// Проверено живьём и стоило бы бага: `example.invalidtldxyz` возвращает 404
    /// без единого редиректа, ровно так же, как несуществующий `.com` — после
    /// него.
    #[tokio::test]
    async fn a_tld_the_redirector_does_not_cover_is_not_a_missing_domain() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/example.invalidtldxyz"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&srv)
            .await;

        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("example.invalidtldxyz")
            .await;

        let RegistryNameservers::Unavailable { reason } = got else {
            panic!("404 редиректора — не утверждение про домен: {got:?}");
        };
        assert!(reason.contains("no RDAP service"), "{reason}");
    }

    /// Реестр ответил отказом — про делегирование мы не знаем ничего. Ни пустым
    /// списком (это соврало бы «NS не прописаны»), ни `NotRegistered` (это
    /// соврало бы про сам домен).
    #[tokio::test]
    async fn a_failing_registry_is_not_an_empty_list() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(ResponseTemplate::new(503).set_body_string("service unavailable"))
            .mount(&srv)
            .await;

        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("betify2.com")
            .await;

        let RegistryNameservers::Unavailable { reason } = got else {
            panic!("отказ реестра обязан быть отдельным состоянием: {got:?}");
        };
        assert!(reason.contains("503"), "{reason}");
    }

    /// Ответ пришёл, но не от реестра — HTML-заглушка посредника. Разбирать её
    /// нечем, и пересказывать её в интерфейс тоже нечего: текст едет в карточку
    /// домена.
    #[tokio::test]
    async fn a_body_that_is_not_rdap_never_reaches_the_caller() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("<html><body>nginx proxy, request id 42</body></html>"),
            )
            .mount(&srv)
            .await;

        let got = RdapClient::with_base_url(&srv.uri())
            .nameservers("betify2.com")
            .await;

        let RegistryNameservers::Unavailable { reason } = got else {
            panic!("HTML вместо JSON — это не ответ про делегирование: {got:?}");
        };
        assert!(reason.contains("not an RDAP object"), "{reason}");
        assert!(!reason.contains("nginx"), "{reason}");
    }

    /// Сети нет — тот же `Unavailable`, что и у отказа реестра: снаружи это одно
    /// и то же незнание.
    #[tokio::test]
    async fn an_unreachable_registry_is_unavailable_too() {
        let got = RdapClient::with_base_url(NOWHERE)
            .nameservers("betify2.com")
            .await;
        assert!(
            matches!(got, RegistryNameservers::Unavailable { .. }),
            "{got:?}"
        );
    }

    /// Пустое имя не должно превращаться в запрос `GET /domain/`: 404 на него
    /// приехал бы как `NotRegistered`, то есть как утверждение про домен, о
    /// котором мы даже не спросили.
    #[tokio::test]
    async fn a_blank_domain_never_reaches_the_network() {
        let got = RdapClient::with_base_url(NOWHERE).nameservers("  .  ").await;
        assert_eq!(
            got,
            RegistryNameservers::Unavailable {
                reason: "empty domain name".into()
            }
        );
    }

    /// Три состояния обязаны быть различимы и НА ФРОНТЕ, а не только в Rust:
    /// команда отдаёт их через serde, и тег — единственное, по чему их там можно
    /// развести.
    #[test]
    fn every_state_is_told_apart_after_serialisation() {
        let json = |v: &RegistryNameservers| serde_json::to_string(v).unwrap();
        assert_eq!(
            json(&RegistryNameservers::Registered {
                nameservers: vec!["ada.ns.cloudflare.com".into()]
            }),
            r#"{"state":"registered","nameservers":["ada.ns.cloudflare.com"]}"#
        );
        assert_eq!(
            json(&RegistryNameservers::NotRegistered),
            r#"{"state":"not_registered"}"#
        );
        assert_eq!(
            json(&RegistryNameservers::Unavailable {
                reason: "timeout".into()
            }),
            r#"{"state":"unavailable","reason":"timeout"}"#
        );
    }
}
