import { domainsKeys } from "./domains";
import { queryClient } from "./queryClient";
import { runExclusive, useRunPending } from "./runGate";
import { chooseSavePath, defaultBackupFileName } from "../lib/chooseSavePath";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
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
      // поэтому `includes`, а не равенство.
      if (message.includes(BACKUP_CANCELLED)) useBackupRunsStore.getState().cancelled(domain.id);
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
