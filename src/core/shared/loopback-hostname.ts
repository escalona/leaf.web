/**
 * Returns whether a URL hostname identifies the local loopback interface.
 *
 * URL implementations disagree on whether IPv6 hostnames retain brackets, so
 * the classifier accepts both forms. IPv4 loopback covers the full 127/8 range.
 */
export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
