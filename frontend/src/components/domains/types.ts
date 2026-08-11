import { Domain } from "../../api/domains";

/**
 * Строка домена в том виде, в каком её показывает вкладка: только те поля,
 * которые действительно рисуются или по которым фильтруют и сортируют.
 *
 * Отдельный тип, а не сам `Domain`, — чтобы у таблицы, карточек и строки был
 * один словарь: они складывались бы из разных подмножеств одного большого
 * ответа, и «какие поля этому экрану нужны» приходилось бы вычитывать из JSX.
 */
export interface DomainUI {
  id: number;
  domain: string;
  server_id: number | null;
  registrar_id: number | null;
  cf_id: number | null;
  ns_status: string;
  status: string;
  ssl_status?: string | null;
  /** Срок домена у регистратора. `date` без времени — считаем сутками. */
  expiry_date?: string | null;
  /** Срок сертификата. Полноценный `datetime`, но вопрос к нему тот же суточный. */
  ssl_expires_at?: string | null;
  last_provision_error?: string | null;
  created: string;
}

/** Ответ API → строка вкладки. Единственное место, где эти поля переименовываются. */
export function toDomainUI(d: Domain): DomainUI {
  return {
    id: d.id,
    domain: d.domain_name,
    server_id: d.server_id,
    registrar_id: d.registrar_id,
    cf_id: d.cloudflare_account_id,
    ns_status: d.ns_status || "pending",
    status: d.status,
    ssl_status: d.ssl_status,
    expiry_date: d.expiry_date,
    ssl_expires_at: d.ssl_expires_at,
    last_provision_error: d.last_provision_error,
    created: d.created_at,
  };
}
