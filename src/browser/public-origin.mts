import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
privateAddresses.addSubnet("2001::", 23, "ipv6");
privateAddresses.addSubnet("2001:db8::", 32, "ipv6");
privateAddresses.addSubnet("2002::", 16, "ipv6");
privateAddresses.addSubnet("3fff::", 20, "ipv6");

/** Public unicast only: includes no loopback, LAN, link-local, reserved,
 * multicast, IPv4-mapped IPv6 or IPv6 transition destinations. */
export function isPublicAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !privateAddresses.check(address, "ipv6")
  );
}
export function parsePublicBrowserURL(value: string, hostOrigin?: string): URL {
  if (value.length > 8192) throw Error("The browser URL is too long.");
  const url = new URL(value);
  const name = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin === hostOrigin ||
    !name ||
    (isIP(name) && !isPublicAddress(name))
  )
    throw Error(
      "Choose a public HTTP or HTTPS website. Crew and private network addresses are protected.",
    );
  return url;
}
export async function requirePublicResolution(
  hostname: string,
  resolve: (name: string) => Promise<{ endpoints: { address: string }[] }>,
): Promise<void> {
  const name = hostname.replace(/^\[|\]$/g, "");
  if (isIP(name)) {
    if (!isPublicAddress(name))
      throw Error("Public browser address is private.");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      resolve(name),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Public browser DNS lookup timed out.")),
          3000,
        );
      }),
    ]);
    if (
      !result.endpoints.length ||
      !result.endpoints.every((e) => isPublicAddress(e.address))
    )
      throw Error("Website must resolve exclusively to public addresses.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
