import { CONFIRMATION_TOKEN_BYTES } from './config.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeEqual(expected, actual) {
  let difference = expected.length ^ actual.length;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected[i] ^ (actual[i] ?? 0);
  }
  return difference === 0;
}

async function hmacKey(secret) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('A signing secret is required');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(value, secret) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value)));
}

export async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function newConfirmationToken() {
  const raw = base64url(crypto.getRandomValues(new Uint8Array(CONFIRMATION_TOKEN_BYTES)));
  return { raw, hash: await sha256(raw) };
}

export async function signActionToken(payload, secret) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url(await hmac(body, secret))}`;
}

export async function verifyActionToken(token, purpose, secret, now = Math.floor(Date.now() / 1000)) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, signature] = parts;
    const supplied = fromBase64url(signature);
    const expected = await hmac(body, secret);
    if (!constantTimeEqual(expected, supplied)) return null;

    const payload = JSON.parse(decoder.decode(fromBase64url(body)));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.purpose !== purpose) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
