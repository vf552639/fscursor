import { describe, it, expect } from "vitest";

import { IP_ADDRESS_MAX_LEN, ipError } from "./ipInput";

/**
 * Правило поля «IP-адрес» — здесь оно ЕДИНСТВЕННОЕ на продукт, а не копия
 * серверного: бэкенд формат адреса не проверяет вовсе и не собирается
 * (`_checked_server_text` в `backend/app/schemas/server.py` это прямо
 * оговаривает). Поэтому цена пропуска — не 422 в форме, а нерабочий SSH и
 * нерабочий URL панели, собранные из принятого мусора.
 *
 * Границы записаны ЛИТЕРАЛАМИ (45/46), а не через `IP_ADDRESS_MAX_LEN`: сверка
 * константы с самой собой зеленела бы при любом её значении, включая то, при
 * котором лишний символ доезжает до Postgres.
 */

describe("ipError — пустое и мусорное", () => {
  it("пустое поле — отказ: адрес обязателен, в отличие от провайдера", () => {
    expect(ipError("")).toBe("IP address is required");
    // Пробелы, а не пустая строка: после обрезки это то же пустое поле, и
    // проверка «не пусто» без обрезки их бы пропустила.
    expect(ipError("   ")).toBe("IP address is required");
  });

  it("управляющие символы отсекаются до отправки", () => {
    // Вставка из терминала приносит ANSI вместе с текстом; на сервере это 422
    // от `is_valid_column_text`, то есть отказ постфактум чужой фразой.
    expect(ipError("10.0.0.7[0m")).toBe("IP address must not contain control characters");
  });

  it("длиннее колонки — отказ с названной границей", () => {
    expect(IP_ADDRESS_MAX_LEN).toBe(45);
    expect(ipError("1".repeat(46))).toContain("45");
  });

  it("обрезка идёт до всех проверок", () => {
    expect(ipError("  10.0.0.7  ")).toBeNull();
  });
});

describe("ipError — IPv4", () => {
  it("обычный адрес проходит", () => {
    expect(ipError("192.168.1.100")).toBeNull();
    expect(ipError("10.0.0.7")).toBeNull();
    expect(ipError("255.255.255.255")).toBeNull();
    expect(ipError("0.0.0.0")).toBeNull();
  });

  it("октет больше 255 не проходит", () => {
    // Легаси прежней регулярки `[0-9]{1,3}`: «999.999.999.999» считался
    // адресом, хотя постучаться по нему нельзя ни SSH, ни браузеру.
    expect(ipError("999.999.999.999")).toBe("Invalid IP address format");
    expect(ipError("256.1.1.1")).toBe("Invalid IP address format");
    expect(ipError("1.1.1.300")).toBe("Invalid IP address format");
  });

  it("не четыре октета — не адрес", () => {
    expect(ipError("1.2.3")).toBe("Invalid IP address format");
    expect(ipError("1.2.3.4.5")).toBe("Invalid IP address format");
    expect(ipError("1.2.3.")).toBe("Invalid IP address format");
  });

  it("адрес с портом — не адрес", () => {
    // Самая частая форма, в которой адрес лежит в записях про SSH. В колонку он
    // попасть не должен: `sshExec` шлёт значение в `host` как есть, а
    // `fastpanelUrlOf` собрал бы из него «https://1.2.3.4:22:8888».
    expect(ipError("1.2.3.4:22")).toBe("Invalid IP address format");
    expect(ipError("1.2.3.4:22", { ipv6: true })).toBe("Invalid IP address format");
  });

  it("хост и URL — не адрес", () => {
    expect(ipError("example.com")).toBe("Invalid IP address format");
    expect(ipError("http://example.com", { ipv6: true })).toBe("Invalid IP address format");
    expect(ipError("srv:", { ipv6: true })).toBe("Invalid IP address format");
    expect(ipError("не адрес: тут", { ipv6: true })).toBe("Invalid IP address format");
  });
});

describe("ipError — IPv6 только там, где он разрешён", () => {
  it("без флага IPv6 отвергается", () => {
    // «Add Server» заводит сервер по IPv4: лишняя свобода в форме создания
    // плодила бы записи, по которым продукт не умеет работать.
    expect(ipError("2a01:4f8:c17:b8f::1")).toBe("Invalid IP address format");
  });

  it("с флагом — принимается во всех обычных формах", () => {
    const v6 = { ipv6: true };
    expect(ipError("2a01:4f8:c17:b8f::1", v6)).toBeNull();
    // Полная форма из восьми групп.
    expect(ipError("2001:0db8:85a3:0000:0000:8a2e:0370:7334", v6)).toBeNull();
    expect(ipError("::1", v6)).toBeNull();
    expect(ipError("fe80::", v6)).toBeNull();
    // IPv4 внутри IPv6 — последней группой, за две группы.
    expect(ipError("::ffff:192.168.1.1", v6)).toBeNull();
  });

  it("сломанные формы не проходят даже с флагом", () => {
    const v6 = { ipv6: true };
    // Два сжатия: сколько нулей за каждым — восстановить нечем.
    expect(ipError("1::2::3", v6)).toBe("Invalid IP address format");
    // Групп больше восьми, и пустое сжатие тут ничего не сжимает.
    expect(ipError("1:2:3:4:5:6:7:8:9", v6)).toBe("Invalid IP address format");
    // Семь групп без сжатия — это не адрес, а половина адреса.
    expect(ipError("1:2:3:4:5:6:7", v6)).toBe("Invalid IP address format");
    // Не-hex внутри группы.
    expect(ipError("2a01:4f8:zzzz::1", v6)).toBe("Invalid IP address format");
    // Группа длиннее четырёх знаков.
    expect(ipError("2a01:4f8:12345::1", v6)).toBe("Invalid IP address format");
    // Голое «::» валидно как «адрес не задан», но адресом СЕРВЕРА быть не может.
    expect(ipError("::", v6)).toBe("Invalid IP address format");
    // Зона интерфейса: в SSH-коннекте и в URL панели она не значит ничего.
    expect(ipError("fe80::1%eth0", v6)).toBe("Invalid IP address format");
    // Встроенный IPv4 — только последней группой.
    expect(ipError("::192.168.1.1:ffff", v6)).toBe("Invalid IP address format");
    // …и только настоящий IPv4.
    expect(ipError("::ffff:999.1.1.1", v6)).toBe("Invalid IP address format");
  });
});
