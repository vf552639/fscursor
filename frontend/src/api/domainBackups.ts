import { domainsKeys } from "./domains";
import { queryClient } from "./queryClient";
import { runExclusive, useRunPending } from "./runGate";
import { chooseSavePath, defaultBackupFileName } from "../lib/chooseSavePath";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { ensureBackupProgressSubscription, useBackupRunsStore } from "../store/backupRuns";
import { useAuthStore } from "../store/auth";

/**
 * Создание резервной копии домена: панель «сохранить как», Tauri-команда,
 * запись подробностей прогона.
 *
 * Отдельный файл, а не строки в `api/domains.ts`: тот уже за тысячу строк, а
 * прецедент отдельного модуля с импортом `domainsKeys` — `api/fullSetup.ts`.
 * Форма прогона списана с `runReadDomainFacts`: `runExclusive` + `isTauri()` +
 * `invokeSynced` + инвалидация в `finally`.
 *
 * **Границы «не соврать», ради которых этот модуль вообще устроен так, а не
 * проще** (каждая под тестом):
 *
 * 1. «Saved» рисует ТОЛЬКО успешный ответ команды. События прогресса не
 *    выставляют его никогда — даже когда `done === total`: сервер мог доложить
 *    последний чанк и упасть на сверке хеша или на `rename`, и файла с
 *    правильным именем на диске не появилось бы вовсе.
 * 2. Отмена панели сохранения не оставляет следа НИКАКОГО: ни строки прогона,
 *    ни ошибки, ни записи в сторе. Человек ничего не запускал.
 * 3. Печатается путь, который ВЕРНУЛА команда, а не тот, что выбрал человек:
 *    панель сохранения дописывает расширение, а Rust ещё и нормализует путь.
 */

/**
 * Ключ гейта — ОДИН НА ДОМЕН, а не на кнопку.
 *
 * Это одна SSH-сессия к одному серверу с одной строкой прогресса, а кнопок у
 * неё будет несколько (создание сейчас, скачивание готовой копии панели —
 * фазой 8). Признак занятости обязан быть общий, иначе вторая кнопка запустит
 * вторую сессию поверх первой. Ровно поэтому и `BackupRuns` в Rust заведён на
 * домен, а не на прогон.
 */
export function domainBackupKey(domainId: number) {
  return ["domain-backup", domainId] as const;
}

/**
 * Ключ гейта САМОЙ ОТМЕНЫ — отдельный, и это не оплошность.
 *
 * Ключ прогона занят на всё время бэкапа (в том и смысл), так что отмена,
 * вставшая в ту же очередь, не выполнилась бы никогда: `runExclusive` увидел бы
 * идущий прогон и промолчал. Свой ключ даёт отмене ровно то, что от гейта
 * нужно ей самой, — не слать вторую команду на второй клик.
 */
export function domainBackupCancelKey(domainId: number) {
  return ["domain-backup-cancel", domainId] as const;
}

/** Часть архива: файлы сайта или дамп базы (`BackupPart` в Rust). */
export interface DomainBackupPart {
  name: string;
  /** `files` | `database`. */
  kind: string;
  sha256: string;
}

/** Ответ `domain_backup_create` (`BackupResult` в `commands/domain_backup.rs`). */
export interface DomainBackupResult {
  file_name: string;
  /** Куда файл лёг на машине пользователя — это и печатается на экране. */
  path: string;
  bytes: number;
  sha256: string;
  parts: DomainBackupPart[];
  warnings: string[];
  duration_ms: number;
  /**
   * Обновился ли снимок домена после успеха. `false` — архив на диске есть, а
   * список копий на вкладке остался прежним; молчать об этом нельзя.
   */
  facts_refreshed: boolean;
}

/**
 * Маркер отмены (`BACKUP_CANCELLED_SENTINEL` в Rust). Приезжает текстом ошибки
 * команды, потому что отменённый прогон — это `Err`; красный тост на него был
 * бы враньём, отмена не авария.
 */
export const BACKUP_CANCELLED = "BACKUP_CANCELLED";

/**
 * Отмена ли это.
 *
 * Разбор строгий — «текст КОНЧАЕТСЯ маркером», а не «содержит его». Содержимое
 * ловило бы маркер и посреди чужой строки, а чужие строки здесь длинные и не
 * наши: в тексте сбоя выгрузки едет путь на сервере, и файл или каталог с таким
 * именем превратил бы аварию в тихое «отменено» — то есть спрятал бы провал.
 * `Display` у `CommandError` ставит маркер последним («api: BACKUP_CANCELLED»),
 * так что строгость ничего не теряет.
 */
function isCancelled(message: string): boolean {
  return message.trimEnd().endsWith(BACKUP_CANCELLED);
}

/** Что нужно прогону от домена: id для команды, имя для имени файла. */
export interface BackupTarget {
  id: number;
  domain_name: string;
}

/**
 * Сделать копию домена и скачать её на диск.
 *
 * Панель сохранения открывается ВНУТРИ гейта — то есть второй клик, пока висит
 * панель, не откроет вторую. Отказ от неё выходит из прогона молча (правило 2),
 * и гейт при этом отпускается: человек не запускал ничего, и запрещать ему
 * следующую попытку не за что.
 */
export async function runCreateDomainBackup(domain: BackupTarget): Promise<void> {
  await runExclusive(domainBackupKey(domain.id), async () => {
    if (!isTauri()) {
      // Кнопки в вебе нет вовсе (принцип №3), но текст один на весь продукт —
      // сочинять здесь второй незачем.
      throw new Error(desktopOnly("Creating backups"));
    }
    const userId = useAuthStore.getState().userId;
    if (!userId) {
      // Заперт сейф — это не «прогон провалился», прогона ещё не было: панель
      // сохранения даже не открывалась. Строка на экране всё же нужна, иначе
      // кнопка выглядит сломанной.
      useBackupRunsStore.getState().failed(domain.id, "Desktop: unlock session (user id missing)");
      return;
    }

    const dest = await chooseSavePath(defaultBackupFileName(domain.domain_name));
    // Правило 2: следа не остаётся вообще. Ни `failed`, ни `cancelled` — в
    // сторе не появляется даже записи, потому что прогона не было.
    if (!dest) return;

    // Подписка — до команды и с ожиданием: `connect` прилетает почти сразу.
    await ensureBackupProgressSubscription();
    useBackupRunsStore.getState().start(domain.id);

    try {
      const result = await invokeSynced<DomainBackupResult>("domain_backup_create", {
        userId,
        domainId: String(domain.id),
        destPath: dest,
      });
      // Правило 1 и правило 3 разом: успех ставится здесь и только здесь, а
      // путь берётся из ответа, а не из `dest`.
      useBackupRunsStore.getState().saved(domain.id, {
        path: result.path,
        fileName: result.file_name,
        bytes: result.bytes,
        warnings: result.warnings ?? [],
        factsRefreshed: result.facts_refreshed !== false,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // Маркер приезжает внутри текста `CommandError` («api: BACKUP_CANCELLED»),
      // поэтому не равенство, но и не вхождение — см. `isCancelled`.
      if (isCancelled(message)) useBackupRunsStore.getState().cancelled(domain.id);
      else useBackupRunsStore.getState().failed(domain.id, message);
    } finally {
      // Свежую строку домена тянем на ОБОИХ исходах, как у чтения фактов:
      // удачный бэкап пересъёмывает снимок и пишет его на сервер write-back'ом,
      // и список копий на вкладке обязан обновиться — даже если карточку к
      // этому моменту закрыли и открыли снова.
      queryClient.invalidateQueries({ queryKey: domainsKeys.all });
    }
  });
}

/**
 * Попросить идущий прогон остановиться.
 *
 * `invokeIfTauri`, а не `invokeSynced`: команда ничего не резолвит из
 * локального кэша — она смотрит только в свой реестр прогонов
 * (`BackupRuns` в managed state), — а круг в сеть за синхронизацией стоял бы
 * ровно там, где от вызова требуется быстрота. Тот же довод, что у чтения
 * хвоста лога.
 *
 * Ответ команды (`true`/`false`) НЕ выбрасывается, и это не педантизм.
 * `false` — «такого прогона в реестре нет», и случаев за ним два. Первый
 * безобиден: прогон кончился сам между нажатием и вызовом, признак и так
 * снимется исходом. Второй — настоящая дыра: между нашим `start()` и
 * `runs.start()` в Rust лежит `syncLocalCache()`, то есть поход в сеть, и всё
 * это время на экране уже стоит живая кнопка отмены. Нажатие в это окно
 * уходит в пустоту — отменять Rust ещё нечего, — и, промолчи мы, человек
 * смотрел бы на «Cancelling…» десятки минут, чтобы в конце получить «Saved».
 * Поэтому на `false` признак снимается: кнопка снова нажимаема, и это правда.
 *
 * Признак «отмену попросили» ставится ДО вызова: реакция придёт через десятки
 * секунд (флаг читается на следующем чанке выгрузки), и всё это время экран
 * обязан показывать, что нажатие услышано.
 */
export async function runCancelDomainBackup(domainId: number): Promise<void> {
  await runExclusive(domainBackupCancelKey(domainId), async () => {
    if (!isTauri()) return;
    useBackupRunsStore.getState().requestCancel(domainId);
    try {
      const accepted = await invokeIfTauri<boolean>("domain_backup_cancel", {
        domainId: String(domainId),
      });
      if (!accepted) useBackupRunsStore.getState().cancelRequestFailed(domainId);
    } catch (e: unknown) {
      // Провал ПРОСЬБЫ — не провал бэкапа: тот всё ещё идёт, и красная строка
      // на его месте объявила бы мёртвым живой прогон. Поэтому исход прогона
      // не трогаем вовсе, а признак снимаем — кнопка снова становится
      // нажимаемой, и это и есть правда: не отменилось.
      console.error("backup cancel failed", e);
      useBackupRunsStore.getState().cancelRequestFailed(domainId);
    }
  });
}

/**
 * Кнопка «создать копию»: запуск и признак «идёт прогон».
 *
 * `pending` читается из `MutationCache` по ключу домена, поэтому переживает
 * закрытие и открытие карточки: второй клик по перемонтированной вкладке новой
 * SSH-сессии не откроет.
 */
export function useCreateDomainBackup(domain: BackupTarget) {
  const pending = useRunPending(domainBackupKey(domain.id));
  return {
    pending,
    run: () => {
      void runCreateDomainBackup(domain);
    },
  };
}

/**
 * Кнопка отмены: запуск и признак «уже попросили».
 *
 * `requested` берётся из стора, а не из `useRunPending`: сама команда отвечает
 * мгновенно, а ждать приходится прогон. Кнопка обязана оставаться погашенной
 * всё это время, иначе человек решит, что нажатие не сработало, и будет жать
 * снова.
 */
export function useCancelDomainBackup(domainId: number) {
  const requested = useBackupRunsStore((s) => s.runs[String(domainId)]?.cancelRequested ?? false);
  return {
    requested,
    run: () => {
      void runCancelDomainBackup(domainId);
    },
  };
}
