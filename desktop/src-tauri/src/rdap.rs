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
//! ## `User-Agent` обязателен, иначе не работает ничего
//!
//! Перед `rdap.org` стоит Cloudflare, и трафик без `User-Agent` он режет: `403`
//! с HTML-страницей «Attention Required!» на КАЖДЫЙ запрос. `reqwest` своего
//! `User-Agent` не ставит — заголовок появляется только из
//! `ClientBuilder::user_agent`, — поэтому без строки с `RDAP_USER_AGENT` этот
//! модуль отвечал бы `Unavailable` на всех доменах без исключения, да ещё и
//! обвиняя реестр в том, чего тот не делал.
//!
//! Это не теория: первая версия модуля именно так и была написана, а живые
//! проверки к ней снимались `curl`'ом, который свой `User-Agent` шлёт сам. Мораль
//! записана здесь, потому что стоила отдельного ревью: **проверять поведение
//! клиента можно только этим клиентом.** Ровно для этого ниже лежит
//! `live_probe_*` — `#[ignore]`-тест, который ходит в настоящий `rdap.org` этим
//! самым кодом; все утверждения про живые ответы в этом файле сняты им.
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
//! отдаёт. Начать с bootstrap означало бы получить «запросить не удалось» на
//! украинских доменах — то есть ровно там, где у нас регистратор без чтения NS.
//!
//! Поэтому: старт с `rdap.org`, bootstrap — в «осталось». Форма ответа
//! (`RegistryNameservers`) от этого выбора не зависит, но одно место зависит и
//! помечено отдельно — разбор двух сортов 404 в `nameservers`.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;

use crate::registrars::normalize_ns;

/// Редиректор RDAP. См. разбор про посредника в докстринге модуля.
const RDAP_REDIRECTOR: &str = "https://rdap.org";

/// Чем представляемся. Без этого заголовка `rdap.org` за Cloudflare отвечает
/// `403` на всё (см. докстринг модуля), а rate-limiter'ы серверов реестров ждут
/// именно его, чтобы не считать нас анонимным ботом. Версия — из `Cargo.toml`,
/// чтобы в логах реестра было видно, какая сборка ходила.
const RDAP_USER_AGENT: &str = concat!("sdmp/", env!("CARGO_PKG_VERSION"));

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
/// Живая цепочка — один хоп; три сверху оставлены на канонизацию адреса на
/// стороне реестра, но это не бесконечность: незамкнутый цикл обязан кончиться
/// названной причиной, а не таймаутом.
const RDAP_MAX_REDIRECTS: usize = 4;

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
    /// Реестр ответил про этот домен, и ответ РАЗОБРАН ЦЕЛИКОМ. Список может
    /// быть пуст — это содержательное «домен зарегистрирован, но никуда не
    /// делегирован» (ключа `nameservers` в таком ответе просто нет). Усечённым
    /// он не бывает: непонятый элемент делает весь ответ `Unavailable`, потому
    /// что часть списка хуже отсутствия списка — её сравнят с зоной Cloudflare и
    /// покажут «расходится» на верном делегировании.
    Registered { nameservers: Vec<String> },
    /// Домена в реестре нет — так сказал САМ РЕЕСТР. Отдельно от «не смогли
    /// спросить»: это утверждение о домене, а не наша неудача.
    NotRegistered,
    /// Спросить не удалось: сети нет, реестр молчит, TLD не покрыт редиректором,
    /// имя не в той форме, ответ не разобрать. Про делегирование мы в этом
    /// случае не знаем НИЧЕГО.
    Unavailable { reason: String },
}

impl RegistryNameservers {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self::Unavailable {
            reason: reason.into(),
        }
    }
}

/// Клиент RDAP.
pub struct RdapClient {
    /// Адрес RDAP-редиректора. Поле, а не константа, — тем же приёмом и по той
    /// же нужде, что у `registrars::hostiq`/`namecheap`: проверять надо не
    /// разбор в отдельной функции, а то, что живой путь ответа зовёт именно её
    /// и что запрос уходит с нужными заголовками.
    base_url: String,
    /// Бюджет запроса — тоже полем, и ровно по той же причине, что `base_url`:
    /// иначе ветку «истёк таймаут» в `transport_reason` не проверить ничем, кроме
    /// теста длиной в `RDAP_TIMEOUT`. Мутация подтвердила, что без этого поля
    /// ветку можно снять, и все тесты останутся зелёными.
    timeout: Duration,
    client: Client,
}

/// Один клиент RDAP на процесс.
///
/// Не микрооптимизация. `Client` внутри — это TLS-конфигурация и пул
/// соединений; собирая его на каждый вызов, бейдж делегирования на списке
/// доменов делал бы 127 TLS-хендшейков к одному хосту вместо одного живого
/// соединения. У `registrars::hostiq` та же цена задокументирована как
/// недостижимая изнутри файла (сервис собирается на каждую tauri-команду вместе
/// с расшифровкой ключей); здесь секретов нет, поэтому рычаг есть — и он здесь.
///
/// `Result` внутри, а не `expect`: сборка клиента теоретически может не удаться
/// (rustls без корневых сертификатов), и паника в async-команде оставила бы
/// промис на фронте невыполненным — карточка навсегда зависла бы в «загружаю»
/// вместо честного `Unavailable`. Модуль утверждает, что неудача — это
/// состояние; путей наружу мимо трёх состояний у него быть не должно ни одного.
///
/// Чего здесь НЕТ и что нужно помнить следующему: ограничения параллелизма.
/// Общий клиент снимает хендшейки, но не мешает потребителю выпустить сто
/// запросов разом в один публичный сервис, лимитирующий по IP; 429 приедет как
/// `Unavailable` на всём списке. Троттлинг — на стороне потребителя (фаза
/// перевода бейджа на этот источник), и без него массовый экран работать не
/// будет.
fn shared() -> &'static Result<RdapClient, String> {
    static SHARED: OnceLock<Result<RdapClient, String>> = OnceLock::new();
    SHARED.get_or_init(|| RdapClient::build(RDAP_REDIRECTOR).map_err(|e| e.to_string()))
}

/// Куда домен делегирован по данным реестра — общим на процесс клиентом.
///
/// Точка входа модуля: tauri-команда зовёт её, а не конструирует клиент сама.
pub async fn registry_nameservers(domain: &str) -> RegistryNameservers {
    match shared() {
        Ok(client) => client.nameservers(domain).await,
        Err(reason) => {
            RegistryNameservers::unavailable(format!("could not build an RDAP client: {reason}"))
        }
    }
}

impl RdapClient {
    fn build(base_url: &str) -> Result<Self, reqwest::Error> {
        Self::build_with_timeout(base_url, RDAP_TIMEOUT)
    }

    fn build_with_timeout(base_url: &str, timeout: Duration) -> Result<Self, reqwest::Error> {
        Ok(Self {
            base_url: base_url.to_string(),
            timeout,
            client: Client::builder()
                .timeout(timeout)
                // Без `User-Agent` не работает ни один домен — см. докстринг
                // модуля. Не «вежливость», а условие получения ответа.
                .user_agent(RDAP_USER_AGENT)
                // Редиректы объявлены явно, хотя таково и умолчание reqwest:
                // без них этот модуль не работает вовсе (см. `RDAP_MAX_REDIRECTS`),
                // и строка тут стоит, чтобы никто не выключил их «за
                // ненадобностью», скопировав билдер от соседа.
                .redirect(Policy::limited(RDAP_MAX_REDIRECTS))
                .build()?,
        })
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
        if !is_ldh_domain(&name) {
            return RegistryNameservers::unavailable(format!(
                "{domain:?} is not a domain name that RDAP can be asked about"
            ));
        }

        let requested = match self.domain_url(&name) {
            Ok(u) => u,
            Err(reason) => return RegistryNameservers::unavailable(reason),
        };
        let resp = match self
            .client
            .get(requested.clone())
            .header(ACCEPT, RDAP_MEDIA_TYPE)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return RegistryNameservers::unavailable(transport_reason(&e, self.timeout)),
        };

        // Кто именно ответил, решается ОДИН раз и здесь: ниже это нужно и для
        // разбора двух сортов 404, и для текста про отказ. Считать «редирект
        // случился» надо до `resp.text()`, пока ответ ещё цел.
        let responder = Responder::of(resp.url(), &requested);
        let status = resp.status();

        if status == StatusCode::NOT_FOUND {
            // 404 у RDAP бывает ДВУХ РАЗНЫХ сортов, и путать их нельзя.
            //
            // Реестр отвечает 404 на домен, которого у него нет, — это
            // `NotRegistered`. Но и сам `rdap.org` отвечает 404, когда не знает
            // RDAP-сервера для этого TLD, — и это уже «спросить не удалось»: про
            // делегирование домена такой ответ не говорит ничего, а зачесть его
            // как «домена нет» значило бы объявить чужой пробел в покрытии
            // приговором нашему домену.
            //
            // Уйдёт посредник (IANA bootstrap, см. докстринг модуля) — это место
            // придётся пересмотреть: там мы будем сразу на реестре, и всякий 404
            // станет честным `NotRegistered`.
            return match responder {
                Responder::Registry => RegistryNameservers::NotRegistered,
                Responder::Redirector => RegistryNameservers::unavailable(
                    "no RDAP service is published for this TLD",
                ),
            };
        }
        if !status.is_success() {
            // Тело сюда НЕ попадает — тем же приёмом и по той же причине, что у
            // `hostiq::failure_text`: текст видит пользователь в карточке
            // домена, а ответ мог прийти не от реестра (заглушка прокси, WAF,
            // капча), и такому в интерфейсе не место. Зато сказано, КТО отказал:
            // «реестр не отвечает» про 403 от Cloudflare перед редиректором
            // отправило бы разбираться не туда.
            return RegistryNameservers::unavailable(format!(
                "{} returned HTTP {status}",
                responder.name()
            ));
        }

        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => return RegistryNameservers::unavailable(transport_reason(&e, self.timeout)),
        };
        match nameservers_of(&text) {
            Ok(nameservers) => RegistryNameservers::Registered { nameservers },
            Err(reason) => {
                RegistryNameservers::unavailable(format!("{} {reason}", responder.name()))
            }
        }
    }

    /// Адрес запроса про домен.
    ///
    /// Имя кладётся `path_segments_mut`, а не `format!`: конкатенация строк
    /// пускает имя в путь как есть, и `Url::parse` потом честно применяет к нему
    /// правила путей. Проверено на `url 2.5.8`: `"a/../.."` даёт
    /// `https://rdap.org/domain/` — ровно тот запрос, который гейт обещает не
    /// делать, — а `"%2e%2e/ip/8.8.8.8"` даёт `https://rdap.org/ip/8.8.8.8`, то
    /// есть ДРУГОЙ эндпоинт RDAP, который ответит 200 и валидным объектом без
    /// `nameservers`. Наружу это уехало бы как «домен зарегистрирован, NS не
    /// прописаны» — утверждение из ничего.
    ///
    /// Гейт `is_ldh_domain` такие имена и так не пропускает, и одного из двух
    /// хватило бы. Стоят оба, потому что отвечают за разное: гейт — за честный
    /// отказ с текстом, эта функция — за то, что `/` и `%` в имени не выведут
    /// запрос из своего сегмента, что бы с гейтом ни сделали дальше.
    ///
    /// Чего она НЕ даёт: `.` и `..` url разрешает, и `".."` здесь даёт `/domain`
    /// без сегмента вовсе. Эти два случая держит ТОЛЬКО гейт — так и записано в
    /// его тесте, чтобы ремень не выглядел прочнее, чем он есть.
    fn domain_url(&self, name: &str) -> Result<Url, String> {
        let mut url = Url::parse(self.base_url.trim_end_matches('/')).map_err(|e| e.to_string())?;
        {
            let Ok(mut segments) = url.path_segments_mut() else {
                return Err(format!("{} cannot carry a path", self.base_url));
            };
            segments.pop_if_empty().extend(["domain", name]);
        }
        Ok(url)
    }
}

/// Кто ответил на запрос — редиректор или сервер реестра.
///
/// Различаются по адресу ответа: `rdap.org` данных не отдаёт вовсе, он только
/// редиректит, — значит ответ с исходного адреса пришёл от посредника (или от
/// того, что стоит перед ним), а ответ с другого адреса — от реестра. Прямая
/// проверка «мы всё ещё там, куда постучались», а не подсчёт хопов, потому что
/// именно это и есть вопрос.
#[derive(Debug, PartialEq, Eq)]
enum Responder {
    Redirector,
    Registry,
}

impl Responder {
    fn of(final_url: &Url, requested: &Url) -> Self {
        if final_url == requested {
            Self::Redirector
        } else {
            Self::Registry
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Redirector => "the RDAP redirector",
            Self::Registry => "the registry RDAP server",
        }
    }
}

/// Похоже ли имя на домен, про который RDAP вообще можно спросить.
///
/// Проверка charset'а, а не «непустая строка»: `normalize_ns` — это
/// `trim` + снятие завершающей точки + нижний регистр, никакой валидации в нём
/// нет, и всё остальное он пропускает как есть (см. `domain_url` — что из этого
/// получалось).
///
/// Единственная сознательная потеря — IDN: юникодное имя (`тест.укр`) здесь
/// отбивается. RDAP спрашивают по `ldhName`, то есть по punycode, а punycode-
/// кодировщика в десктопе нет; отбить с текстом честнее, чем сходить не туда.
/// Появится IDN в доменах пользователя — здесь и появится `idna`.
fn is_ldh_domain(name: &str) -> bool {
    let ldh_label = |label: &str| {
        !label.is_empty()
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    // Точка обязательна: у домена есть TLD, а односложное имя — это или мусор,
    // или другой эндпоинт RDAP.
    name.contains('.') && name.split('.').all(ldh_label)
}

/// Как назвать транспортный сбой.
///
/// По сортам, а не одним `e.to_string()`: `Display` у `reqwest::Error` печатает
/// сорт и адрес, но не источник, поэтому таймаут, отсутствие сети, отказ
/// соединения и сбой TLS сливались в одну неразличимую строку, а исчерпание
/// редиректов приезжало как `error following redirect` — без слова «хопов
/// слишком много». Текст видит пользователь в карточке домена, и разные причины
/// он чинит по-разному: подождать, включить сеть, разбираться с прокси.
///
/// Адрес в тексте оставлен намеренно: в URL нет ничего, кроме имени домена, — ни
/// ключей, ни токенов. (У `namecheap::transport_err` адрес вычищается ровно
/// потому, что там в query-строке едет credential; разница не в стиле.)
fn transport_reason(e: &reqwest::Error, timeout: Duration) -> String {
    if e.is_timeout() {
        format!("the RDAP request timed out after {:?}", timeout)
    } else if e.is_redirect() {
        format!("the RDAP redirect chain did not end within {RDAP_MAX_REDIRECTS} hops")
    } else if e.is_connect() {
        format!("could not connect to the RDAP service: {e}")
    } else {
        format!("the RDAP request failed: {e}")
    }
}

/// Имена nameservers из тела ответа RDAP — либо причина, по которой тело не
/// считается ответом про делегирование.
///
/// Граница между `Ok(vec![])` и `Err` здесь — это и есть граница между
/// `Registered` без делегирования и `Unavailable`, поэтому каждый её случай
/// перечислен явно, а не сведён к «разобрали / не разобрали»:
///
/// * **ключа `nameservers` нет** → `Ok(vec![])`. Родная форма RDAP для
///   зарегистрированного, но не делегированного домена; звать её сбоем нельзя.
/// * **тело не JSON-объект** → `Err`. Так выглядит HTML-заглушка посредника.
/// * **в теле объект ошибки RDAP** (`errorCode`) → `Err`. Согласованности между
///   десятками серверов реестров ждать нечем: тот же `rdap.hostmaster.ua`
///   отдаёт этот объект с HTTP 404, но полагаться на то, что так делают все, —
///   значит однажды зачесть текст ошибки за «NS не прописаны».
/// * **`nameservers` есть, но не массив** → `Err`. «Поле не разобрали» — это
///   незнание, и сливать его с «ключа нет» (ответом!) нельзя.
/// * **элемент без пригодного `ldhName`** → `Err` на ВЕСЬ ответ. Молча выбросить
///   его значило бы отдать список УСЕЧЁННЫМ: потребитель сравнит его со списком
///   зоны Cloudflare и покажет «расходится» на верном делегировании — та же
///   ошибка, ради которой в разборе стоит `normalize_ns`, только через другую
///   дверь.
///
/// Признак «похоже на RDAP» намеренно слабый — «это JSON-объект без
/// `errorCode`», а не наличие `objectClassName`: RDAP-серверов реестров десятки,
/// и каждый вольничает с необязательными полями. Строгая проверка выбрасывала бы
/// валидные ответы, а всё, что этому правилу удаётся пропустить, ловится
/// разбором самих элементов.
fn nameservers_of(body: &str) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| "returned a body that is not JSON".to_string())?;
    let object = value
        .as_object()
        .ok_or("returned a JSON body that is not an RDAP object")?;
    if let Some(code) = object.get("errorCode") {
        // Код — число, его печатать безопасно; `title`/`description` — свободный
        // текст сервера, и в интерфейс он не едет (см. `hostiq::failure_text`).
        return Err(format!("returned an RDAP error object (errorCode {code})"));
    }
    let Some(field) = object.get("nameservers") else {
        return Ok(Vec::new());
    };
    let items = field
        .as_array()
        .ok_or("returned a `nameservers` field that is not an array")?;

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        // `ldhName` — ASCII-форма имени; реестры пишут её то в верхнем регистре,
        // то с завершающей точкой. Нормализуем тем же выражением, что и всё
        // остальное: список отсюда сравнивается со списком зоны Cloudflare, и
        // разъехавшиеся правила дали бы «расходится» на верном делегировании.
        let host = item
            .get("ldhName")
            .and_then(|v| v.as_str())
            .map(normalize_ns)
            .filter(|h| !h.is_empty())
            .ok_or("returned a nameserver entry without a usable `ldhName`")?;
        out.push(host);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Закрытый порт: любая попытка сходить в сеть отсюда провалится и будет
    /// отличима от ожидаемой ошибки по тексту.
    const NOWHERE: &str = "http://127.0.0.1:1";

    fn client_for(base_url: &str) -> RdapClient {
        RdapClient::build(base_url).expect("клиент RDAP не собрался")
    }

    fn rdap_domain(nameservers: Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objectClassName": "domain",
            "ldhName": "betify2.com",
            "nameservers": nameservers,
        }))
    }

    fn redirect_to(target: &MockServer, path_and_name: &str) -> ResponseTemplate {
        ResponseTemplate::new(302)
            .insert_header("location", format!("{}{path_and_name}", target.uri()).as_str())
    }

    fn reason_of(got: RegistryNameservers) -> String {
        match got {
            RegistryNameservers::Unavailable { reason } => reason,
            other => panic!("ожидался Unavailable, пришло {other:?}"),
        }
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
        let got = client_for(&srv.uri()).nameservers("Betify2.COM.").await;

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

    /// Оба заголовка держатся матчерами живого запроса, а не чтением кода.
    ///
    /// `User-Agent` — блокирующий: без него `rdap.org` за Cloudflare отвечает
    /// `403` на КАЖДЫЙ домен, а `reqwest` сам его не ставит. Первая версия
    /// модуля была именно такой, и мок этого не поймал бы — wiremock отвечает на
    /// что угодно, — поэтому здесь стоит матчер, а в конце файла лежит
    /// `#[ignore]`-проверка настоящим `rdap.org`.
    ///
    /// `Accept` — про то, что часть серверов реестров без него отдаёт HTML.
    #[tokio::test]
    async fn the_request_introduces_itself_and_asks_for_rdap_json() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .and(header("Accept", RDAP_MEDIA_TYPE))
            .and(header("User-Agent", RDAP_USER_AGENT))
            .respond_with(rdap_domain(serde_json::json!([])))
            .mount(&srv)
            .await;

        let got = client_for(&srv.uri()).nameservers("betify2.com").await;

        // Мок отвечает только на запрос с обоими заголовками; не хватит любого —
        // wiremock вернёт 404, а он у нас значит совсем другое.
        assert!(
            matches!(got, RegistryNameservers::Registered { .. }),
            "{got:?}"
        );
        // И сама подпись должна быть подписью, а не пустой строкой: пустой
        // `User-Agent` Cloudflare режет так же, как отсутствующий.
        assert!(
            RDAP_USER_AGENT.starts_with("sdmp/") && RDAP_USER_AGENT.len() > "sdmp/".len(),
            "{RDAP_USER_AGENT}"
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
            .and(header("User-Agent", RDAP_USER_AGENT))
            .respond_with(rdap_domain(serde_json::json!([
                {"ldhName": "ada.ns.cloudflare.com"}
            ])))
            .mount(&registry)
            .await;

        let redirector = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(redirect_to(&registry, "/domain/betify2.com"))
            .mount(&redirector)
            .await;

        let got = client_for(&redirector.uri())
            .nameservers("betify2.com")
            .await;

        assert_eq!(
            got,
            RegistryNameservers::Registered {
                nameservers: vec!["ada.ns.cloudflare.com".to_string()]
            }
        );
    }

    /// Незамкнутая цепочка редиректов обязана кончиться НАЗВАННОЙ причиной.
    /// `Display` у reqwest говорит про неё только `error following redirect`, из
    /// чего пользователь не узнает ничего.
    #[tokio::test]
    async fn an_endless_redirect_chain_is_named_as_such() {
        let srv = MockServer::start().await;
        // Редирект сам на себя: адрес тот же, поэтому цикл не кончится сам.
        let uri = srv.uri();
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{uri}/domain/betify2.com").as_str()),
            )
            .mount(&srv)
            .await;

        let reason = reason_of(client_for(&uri).nameservers("betify2.com").await);
        assert!(reason.contains("redirect chain"), "{reason}");
        assert!(reason.contains("hops"), "{reason}");
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

        let got = client_for(&srv.uri()).nameservers("betify2.com").await;

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
            .respond_with(redirect_to(&registry, "/domain/missing.com"))
            .mount(&redirector)
            .await;

        let got = client_for(&redirector.uri()).nameservers("missing.com").await;

        assert_eq!(got, RegistryNameservers::NotRegistered);
    }

    /// А 404 ОТ РЕДИРЕКТОРА — совсем другое: так `rdap.org` отвечает про TLD, у
    /// которого он не знает RDAP-сервера. Про сам домен это не говорит ничего, и
    /// зачесть его как «домена нет в реестре» значило бы объявить чужой пробел в
    /// покрытии приговором нашему домену.
    #[tokio::test]
    async fn a_tld_the_redirector_does_not_cover_is_not_a_missing_domain() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/example.invalidtldxyz"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&srv)
            .await;

        let reason = reason_of(
            client_for(&srv.uri())
                .nameservers("example.invalidtldxyz")
                .await,
        );
        assert!(reason.contains("no RDAP service"), "{reason}");
    }

    /// Отказ обязан называть ТОГО, КТО ОТКАЗАЛ. `403` перед редиректором — это
    /// живой случай (Cloudflare режет запросы без `User-Agent`), и «реестр не
    /// отвечает» отправило бы искать поломку в реестре.
    #[tokio::test]
    async fn a_refusal_names_who_refused() {
        let blocked = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(ResponseTemplate::new(403).set_body_string(
                "<!DOCTYPE html><title>Attention Required! | Cloudflare</title>",
            ))
            .mount(&blocked)
            .await;

        let reason = reason_of(client_for(&blocked.uri()).nameservers("betify2.com").await);
        assert!(reason.contains("redirector returned HTTP 403"), "{reason}");
        // Тело чужой заглушки в интерфейс не едет.
        assert!(!reason.contains("Cloudflare"), "{reason}");

        // Тот же отказ, но после редиректа, — уже вина реестра, и назван он
        // должен быть иначе.
        let registry = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&registry)
            .await;
        let redirector = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(redirect_to(&registry, "/domain/betify2.com"))
            .mount(&redirector)
            .await;

        let reason = reason_of(
            client_for(&redirector.uri())
                .nameservers("betify2.com")
                .await,
        );
        assert!(reason.contains("registry"), "{reason}");
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

        let reason = reason_of(client_for(&srv.uri()).nameservers("betify2.com").await);
        assert!(reason.contains("not JSON"), "{reason}");
        assert!(!reason.contains("nginx"), "{reason}");
    }

    /// Тело, которое разобрать НЕ УДАЛОСЬ, обязано остаться `Unavailable` — ни
    /// одно из этих трёх не смеет стать `Registered { nameservers: [] }`, потому
    /// что это утверждение «домен никуда не делегирован», сделанное из ничего.
    ///
    /// Все три — не выдумка: объект ошибки RDAP с кодом 2xx возможен ровно
    /// потому, что «похоже на RDAP» мы проверяем слабо; `nameservers` не
    /// массивом и элемент без `ldhName` — то, что при `and_then(as_array)` и
    /// `filter_map` съедалось молча.
    #[tokio::test]
    async fn an_unreadable_body_never_becomes_an_empty_delegation() {
        let cases: [(&str, Value, &str); 3] = [
            (
                "объект ошибки RDAP с успешным кодом",
                serde_json::json!({"errorCode": 404, "title": "Not Found"}),
                "errorCode 404",
            ),
            (
                "`nameservers` не массивом",
                serde_json::json!({"objectClassName": "domain", "nameservers": "ns1.example.com"}),
                "not an array",
            ),
            (
                "элемент без `ldhName`",
                serde_json::json!({"objectClassName": "domain", "nameservers": [
                    {"ldhName": "ada.ns.cloudflare.com"},
                    {"unicodeName": "боб.нс.example"}
                ]}),
                "without a usable `ldhName`",
            ),
        ];

        for (what, body, expected) in cases {
            let srv = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/domain/betify2.com"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&srv)
                .await;

            let got = client_for(&srv.uri()).nameservers("betify2.com").await;
            let reason = match got {
                RegistryNameservers::Unavailable { reason } => reason,
                other => panic!("{what}: разобрано как {other:?}"),
            };
            assert!(reason.contains(expected), "{what}: {reason}");
        }
    }

    /// Сети нет — тот же `Unavailable`, что и у отказа реестра, но с названной
    /// причиной: «не удалось соединиться» и «истёк таймаут» пользователь чинит
    /// по-разному.
    #[tokio::test]
    async fn an_unreachable_registry_is_unavailable_too() {
        let reason = reason_of(client_for(NOWHERE).nameservers("betify2.com").await);
        assert!(reason.contains("could not connect"), "{reason}");
    }

    /// Молчащий реестр — тоже своя причина, а не «запрос не удался».
    ///
    /// Тест существует потому, что мутация это доказала: пока бюджет запроса был
    /// константой, ветку «истёк таймаут» можно было снять целиком, и все тесты
    /// оставались зелёными — проверить её было нечем, кроме теста длиной в
    /// `RDAP_TIMEOUT`. Отсюда поле `timeout` у клиента.
    #[tokio::test]
    async fn a_registry_that_never_answers_is_named_a_timeout() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/betify2.com"))
            .respond_with(
                rdap_domain(serde_json::json!([])).set_delay(Duration::from_millis(400)),
            )
            .mount(&srv)
            .await;

        let client = RdapClient::build_with_timeout(&srv.uri(), Duration::from_millis(40))
            .expect("клиент RDAP не собрался");
        let reason = reason_of(client.nameservers("betify2.com").await);
        assert!(reason.contains("timed out"), "{reason}");
    }

    /// Имя, про которое RDAP спросить нельзя, отбивается БЕЗ СЕТИ.
    ///
    /// Не гигиена. Пока имя ехало в путь конкатенацией, `"%2e%2e/ip/8.8.8.8"`
    /// давало запрос на `/ip/8.8.8.8` — другой эндпоинт RDAP, который отвечает
    /// 200 и валидным объектом без `nameservers`, то есть наружу уезжало
    /// «зарегистрирован, NS не прописаны» про домен, о котором не спрашивали. А
    /// `"a/../.."` давало `/domain/` — ровно тот запрос, которого гейт обещает
    /// не делать. Сегодня это спасается тем, что 404 редиректора читается как
    /// `Unavailable`; после переезда на IANA bootstrap спасать будет нечему.
    #[tokio::test]
    async fn a_name_rdap_cannot_be_asked_about_never_reaches_the_network() {
        // Адрес заведомо мёртвый: ошибка обязана быть про имя, а не про сеть.
        let client = client_for(NOWHERE);
        for name in [
            "",
            "  .  ",
            "localhost",
            "a/../..",
            "%2e%2e/ip/8.8.8.8",
            // `.` и `..` держит только гейт: `path_segments_mut` их разрешает
            // (см. `a_name_with_a_slash_cannot_escape_its_path_segment`).
            ".",
            "..",
            "тест.укр",
            "example .com",
            "a..b",
        ] {
            let reason = reason_of(client.nameservers(name).await);
            assert!(
                reason.contains("not a domain name"),
                "{name:?} уехало в сеть: {reason}"
            );
        }

        // И наоборот: нормальные имена гейт не отбивает — иначе он «работал» бы,
        // не пропуская вообще ничего.
        for name in ["betify2.com", "hostiq.ua", "sub.example.co.uk", "xn--80ak6aa92e.com"] {
            let reason = reason_of(client.nameservers(name).await);
            assert!(
                reason.contains("could not connect"),
                "{name:?} отбит гейтом: {reason}"
            );
        }
    }

    /// Имя со слэшем не выходит за свой сегмент и не меняет эндпоинт.
    ///
    /// Единственный тест в этом файле, который зовёт внутренность напрямую, и это
    /// не лень: `domain_url` — второй ремень к `is_ldh_domain`, и держит он ровно
    /// тот случай, когда первый ослаблен. Через живой путь такое недостижимо по
    /// построению (гейт стоит раньше), а мутация показала, что без этого теста
    /// `path_segments_mut` можно вернуть к `format!`, и все тесты останутся
    /// зелёными — то есть ремень не был бы удержан ничем.
    ///
    /// Что ломала конкатенация (проверено на `url 2.5.8`): `"%2e%2e/ip/8.8.8.8"`
    /// давало `https://rdap.org/ip/8.8.8.8` — ДРУГОЙ эндпоинт RDAP, который
    /// отвечает 200 и валидным объектом без `nameservers`, то есть наружу уезжало
    /// «зарегистрирован, NS не прописаны» про домен, о котором не спрашивали.
    /// Здесь то же имя даёт `/domain/%252e%252e%2Fip%2F8.8.8.8`: и `%`, и `/`
    /// закодированы, сегмент один.
    ///
    /// Границу этого ремня фиксируем честно: `.` и `..` он НЕ держит — url их
    /// разрешает, и `".."` даёт `/domain` без сегмента вовсе. Их отбивает только
    /// гейт (метка между точками не может быть пустой), и в его тесте они стоят
    /// отдельными строками. Уберут гейт — вернётся и эта дыра.
    #[test]
    fn a_name_with_a_slash_cannot_escape_its_path_segment() {
        let client = client_for("https://rdap.org");
        for name in ["a/../..", "%2e%2e/ip/8.8.8.8", "x/y", "ip/8.8.8.8"] {
            let url = client.domain_url(name).expect("адрес не собрался");
            let segments: Vec<&str> = url.path_segments().expect("путь без сегментов").collect();
            assert_eq!(
                segments.len(),
                2,
                "{name:?} расползлось по пути: {url} → {segments:?}"
            );
            assert_eq!(segments[0], "domain", "{name:?} сменило эндпоинт: {url}");
        }
    }

    /// Клиент — один на процесс: `Client` внутри несёт TLS-конфиг и пул
    /// соединений, и сборка его на вызов дала бы 127 хендшейков к одному хосту
    /// на списке доменов.
    #[test]
    fn the_client_is_built_once_per_process() {
        assert!(std::ptr::eq(shared(), shared()));
    }

    /// И собирается он в этом окружении УСПЕШНО. Тест дешёвый, а держит он
    /// единственный путь, которым модуль мог бы ответить не состоянием, а
    /// паникой: `expect` внутри `Client::builder()` оставил бы промис на фронте
    /// невыполненным, и карточка зависла бы в «загружаю» навсегда.
    #[test]
    fn the_shared_client_builds_instead_of_panicking() {
        assert!(shared().is_ok(), "{:?}", shared().as_ref().err());
    }

    /// Три состояния обязаны быть различимы и НА ФРОНТЕ, а не только в Rust:
    /// команда отдаёт их через serde, и тег — единственное, по чему их там можно
    /// развести. Живым путём этот тест не идёт намеренно — он про контракт с TS.
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

    /// Живая проверка НАСТОЯЩИМ `rdap.org` — этим самым клиентом.
    ///
    /// `#[ignore]`, потому что зависит от сети и чужого сервиса; запускается
    /// руками: `cargo test --lib rdap::tests::live_probe -- --ignored --nocapture`.
    ///
    /// Существует она не для полноты покрытия, а из-за конкретной ошибки: первая
    /// версия модуля не ставила `User-Agent` и получала `403` на каждом домене,
    /// при том что все живые проверки к ней были сняты `curl`'ом, который
    /// `User-Agent` шлёт сам. Ни один мок такое не поймает — wiremock отвечает на
    /// что угодно. Поэтому утверждения этого файла про живые ответы проверяются
    /// здесь, и менять их надо ПО РЕЗУЛЬТАТУ этого теста, а не наоборот.
    ///
    /// И проверяются они `assert`'ами, а не глазами: печать четырёх ответов роль
    /// замка не исполняет — со снятым `.user_agent(…)` такая проба напечатала бы
    /// четыре `Unavailable { reason: "the RDAP redirector returned HTTP 403" }` и
    /// вышла бы «зелёной». Каждый из четырёх доменов ниже держит своё состояние,
    /// и все три состояния модуля представлены: без этого «работает» означало бы
    /// «не паникует».
    #[tokio::test]
    #[ignore = "ходит в настоящий rdap.org"]
    async fn live_probe_confirms_what_this_module_claims() {
        let client = shared().as_ref().expect("клиент RDAP");

        // Делегированные домены: `.com` через `rdap.verisign.com`, `.ua` через
        // `rdap.hostmaster.ua` (второго в IANA bootstrap нет — см. докстринг
        // модуля, поэтому именно он держит выбор редиректора).
        //
        // Список обязан быть НЕПУСТЫМ, и это главное утверждение пробы: пустой
        // `Registered` — законное состояние протокола («не делегирован никуда»),
        // но на этих двух доменах он означал бы потерянный разбор `nameservers`,
        // то есть красный бейдж «расходится» на верном делегировании.
        for domain in ["betify2.com", "hostiq.ua"] {
            match client.nameservers(domain).await {
                RegistryNameservers::Registered { nameservers } => {
                    assert!(
                        !nameservers.is_empty(),
                        "{domain}: реестр ответил без nameservers"
                    );
                    println!("{domain} -> {nameservers:?}");
                }
                other => panic!("{domain}: ожидался Registered, получено {other:?}"),
            }
        }

        // 404 ПОСЛЕ редиректа — слово реестра «такого домена нет».
        assert_eq!(
            client.nameservers("nosuchdomain-zzz9988.com").await,
            RegistryNameservers::NotRegistered,
            "незарегистрированный домен обязан отличаться от «спросить не удалось»"
        );

        // 404 БЕЗ редиректа — редиректор не знает такого TLD, то есть спросить
        // не удалось. Различие двух сортов 404 живёт только здесь: перепутав их,
        // модуль объявил бы «домена не существует» о любом домене в непокрытой
        // зоне.
        match client.nameservers("example.invalidtldxyz").await {
            RegistryNameservers::Unavailable { reason } => println!("непокрытый TLD -> {reason}"),
            other => panic!("непокрытый TLD: ожидался Unavailable, получено {other:?}"),
        }
    }
}
