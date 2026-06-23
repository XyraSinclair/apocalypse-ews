#!/usr/bin/env node

const { webcrypto } = require('node:crypto');

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function main() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyBytes = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  if (!privateJwk.d) {
    throw new Error('Generated VAPID private key is missing the P-256 scalar.');
  }
  process.stdout.write([
    `WEB_PUSH_VAPID_PUBLIC_KEY=${bytesToBase64Url(publicKeyBytes)}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${privateJwk.d}`,
    'WEB_PUSH_CONTACT=mailto:alerts@example.com',
    '',
  ].join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
