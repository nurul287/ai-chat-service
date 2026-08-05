/**
 * String-level validation for tenant-supplied endpoint URLs.
 *
 * A tenant registers an arbitrary URL that this service then calls
 * server-side, with the response streamed back to the chat client as a
 * `tool_call` event. Without these checks that is a straightforward SSRF
 * primitive: an authenticated tenant could point a tool at the cloud metadata
 * endpoint or an internal service and read the response out of the chat
 * stream.
 *
 * These are *string-level* checks against the literal host in the URL. A
 * hostname that passes here but resolves to a private address at request time
 * (DNS rebinding) is not caught — that is a known residual gap, not something
 * this module claims to solve.
 */

/** Hosts under these suffixes are internal by convention (and by Railway's private networking). */
const DISALLOWED_HOST_SUFFIXES = [".internal", ".local", ".localhost"];

/**
 * Splits a dotted-quad into its four numeric octets, or null if the string is
 * not a plain IPv4 literal. Numeric so that ranges are checked by value —
 * a loose string match would both miss forms like `010.0.0.1` and falsely
 * reject legitimate public addresses that merely start with the same digits
 * (e.g. `10.0.0.1` must be caught, `100.20.30.40` must not).
 */
function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function isDisallowedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this network", resolves to localhost on many stacks
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local — the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  return false;
}

/** Expands an IPv6 literal (including `::` compression) to its 8 numeric groups, or null. */
function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));

  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function isDisallowedIpv6(address: string): boolean {
  const addr = address.split("%")[0]!.toLowerCase(); // drop any zone id (fe80::1%eth0)

  // An IPv4 address embedded in the trailing group (`::ffff:169.254.169.254`)
  // reaches exactly the same host as the plain IPv4 form, so it gets the same
  // treatment rather than sliding through as "some IPv6 address".
  const embedded = parseIpv4Octets(addr.slice(addr.lastIndexOf(":") + 1));
  if (embedded) return isDisallowedIpv4(embedded);

  const groups = expandIpv6(addr);
  if (!groups) return false;

  // :: (unspecified) and ::1 (loopback), in any written form.
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7]! <= 1) return true;

  const first = groups[0]!;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/**
 * True when a hostname must not be called outbound: loopback, link-local,
 * private IPv4 ranges, IPv6 loopback/link-local/unique-local, and hostnames
 * under an internal-by-convention suffix.
 */
export function isDisallowedHost(hostname: string): boolean {
  // A trailing dot ("example.com.") is the same host; strip it so suffix
  // matching is not trivially bypassed by "postgres.railway.internal.".
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return true;

  // `new URL(...).hostname` keeps IPv6 literals in bracket form.
  if (host.startsWith("[") && host.endsWith("]")) return isDisallowedIpv6(host.slice(1, -1));

  if (host === "localhost") return true;
  if (DISALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const octets = parseIpv4Octets(host);
  if (octets) return isDisallowedIpv4(octets);

  return false;
}

/**
 * True when a tenant-supplied endpoint URL is safe to register: parseable,
 * `https:`, and not pointed at an internal host.
 */
export function isAllowedEndpointUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== null && url.protocol === "https:" && !isDisallowedHost(url.hostname);
}

export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
