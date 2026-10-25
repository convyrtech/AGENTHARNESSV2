// Локальные и частные адреса web_fetch не читает и никуда не отправляет (ревью #23, п. 3). Иначе страница из
// интернета редиректом уводит на http://localhost:8888/tree?token=… (Jupyter, панели роутера, сервисы в LAN), а
// запасные пути (шлюз, Jina) получают этот адрес вместе с токеном. Проверяется адрес, каждый шаг редиректа и
// IP, в который имя разрешается. Свой локальный сервер агент читает curl'ом в bash — это его машина.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolve = (host: string) => Promise<string[]>;

function v4(ip: string): number[] | undefined {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)
    ? parts
    : undefined;
}

/** Частный, локальный, служебный или широковещательный IP (v4 и v6, в том числе v4 внутри v6). */
export function isPrivateIp(ip: string): boolean {
  const a = v4(ip);
  if (a) {
    const [x, y] = a as [number, number, number, number];
    return (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0 && a[2] === 0) ||
      (x === 198 && (y === 18 || y === 19)) ||
      x >= 224
    );
  }
  const s = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (isIP(s) !== 6) return false;
  const mapped =
    /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1] ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (mapped) return isPrivateIp(mapped);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) {
    const [hi, lo] = s
      .slice(7)
      .split(":")
      .map((h) => parseInt(h, 16)) as [number, number];
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (s === "::" || s === "::1") return true;
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 — частные
    (first & 0xffc0) === 0xfe80 || // fe80::/10 — локальные для канала
    (first & 0xff00) === 0xff00 // ff00::/8 — групповые
  );
}

const LOCAL_SUFFIX =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i;

/** Имя или IP в адресе — локальные по виду (без DNS): localhost, *.local, одно слово без точки, частный IP. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!h) return true;
  if (isIP(h)) return isPrivateIp(h);
  // 2130706433, 0x7f000001, 0177.0.0.1 — числовые записи, которые fetch понимает как IP
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h)) return true;
  if (!h.includes(".")) return true;
  return LOCAL_SUFFIX.test(h);
}

export class PrivateAddressError extends Error {}

const defaultResolve: Resolve = async (host) => {
  const all = await lookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
};

/**
 * Адрес можно читать и передавать наружу: http(s), имя не локальное, все его IP — публичные. Имя не разрешилось
 * (нет DNS за прокси, нет такого имени) — пропускаем: прочитать его всё равно сможет только прокси или никто.
 */
export async function assertPublicUrl(
  url: string,
  resolve: Resolve = defaultResolve,
): Promise<URL> {
  return (await checkPublicUrl(url, resolve)).url;
}

/**
 * То же, что assertPublicUrl, и проверенные IP: соединение идёт ровно на них (pinned.ts), чтобы имя не успело
 * разрешиться заново в частный адрес (DNS rebinding). Пусто — имя не разрешилось или это IP в адресе.
 */
export async function checkPublicUrl(
  url: string,
  resolve: Resolve = defaultResolve,
): Promise<{ url: URL; ips: string[] }> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new PrivateAddressError("только http и https");
  if (isPrivateHost(u.hostname))
    throw new PrivateAddressError(
      "локальный или частный адрес: web_fetch читает только интернет (свой сервер — curl в bash)",
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { url: u, ips: [host] };
  let ips: string[] = [];
  try {
    ips = await Promise.race([
      resolve(host),
      new Promise<string[]>((r) => setTimeout(() => r([]), 3_000).unref?.()),
    ]);
  } catch {
    ips = [];
  }
  if (ips.some(isPrivateIp))
    throw new PrivateAddressError(
      `${host} указывает на частный адрес: web_fetch читает только интернет`,
    );
  return { url: u, ips };
}
