const BLOCKED_HOSTS = new Set(['localhost', '0.0.0.0']);
const BLOCKED_PREFIXES = [
  '127.', // loopback
  '10.', // RFC1918
  '192.168.',
  '169.254.', // link-local + cloud metadata
  '100.64.', // CGNAT
];

export function isSafeUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return false;
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (BLOCKED_PREFIXES.some((p) => host.startsWith(p))) return false;
    // IPv6 loopback / link-local (URL parser strips brackets from hostname)
    if (host === '::1' || host === '[::1]' || host.startsWith('fe80:')) return false;
    return true;
  } catch {
    return false;
  }
}
