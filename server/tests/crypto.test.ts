import { decryptText, encryptBytes, decryptBytes, encryptText, sha256 } from '../src/lib/crypto';

describe('AES-256-GCM crypto', () => {
  it('round-trips text and bytes', () => {
    expect(decryptText(encryptText('Priya visited today'))).toBe('Priya visited today');
    expect(decryptText(encryptText(''))).toBe('');
    const buf = Buffer.from([0, 1, 2, 250, 255]);
    expect(decryptBytes(encryptBytes(buf)).equals(buf)).toBe(true);
  });

  it('uses a fresh IV each time (same input -> different ciphertext)', () => {
    expect(encryptText('same')).not.toBe(encryptText('same'));
  });

  it('does not contain the plaintext', () => {
    expect(encryptText('secret memory')).not.toContain('secret');
  });

  it('rejects tampered ciphertext', () => {
    const parts = encryptText('hello world').split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptText(parts.join(':'))).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptText('nope')).toThrow('Unsupported');
  });

  it('sha256 is deterministic hex', () => {
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('abc')).toBe(sha256('abc'));
  });
});
