import { describe, expect, it } from 'vitest';
import { isSafeUrl } from '../../../src/tools/util/safe-url.js';

describe('isSafeUrl', () => {
  it('accepts public https/http', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com/path')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('ftp://example.com')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects loopback', () => {
    expect(isSafeUrl('http://localhost')).toBe(false);
    expect(isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(isSafeUrl('http://0.0.0.0')).toBe(false);
    expect(isSafeUrl('http://[::1]')).toBe(false);
  });

  it('rejects RFC1918 / CGNAT / link-local', () => {
    expect(isSafeUrl('http://10.0.0.1')).toBe(false);
    expect(isSafeUrl('http://192.168.1.1')).toBe(false);
    expect(isSafeUrl('http://169.254.169.254')).toBe(false); // AWS metadata
    expect(isSafeUrl('http://100.64.0.1')).toBe(false); // CGNAT
  });

  it('rejects .local / .internal', () => {
    expect(isSafeUrl('http://myhost.local')).toBe(false);
    expect(isSafeUrl('https://service.internal')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});
