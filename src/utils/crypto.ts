/**
 * AES-256-GCM encryption for API keys.
 *
 * How it works:
 * - AES-256-GCM is an authenticated encryption algorithm — it encrypts AND
 *   verifies integrity. If someone tampers with the ciphertext, decryption fails.
 * - A random 16-byte IV (initialization vector) is generated per encryption call,
 *   ensuring the same plaintext produces different ciphertext each time.
 * - The auth tag (16 bytes) is appended to detect tampering.
 * - Output format: "iv:authTag:ciphertext" (all hex-encoded).
 *
 * Why AES-256-GCM over alternatives:
 * - AES-256-CBC: no built-in authentication — vulnerable to padding oracle attacks.
 * - ChaCha20-Poly1305: great alternative, but AES-GCM has hardware acceleration
 *   on most x86 CPUs (including Lambda), making it faster.
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Format: iv:authTag:ciphertext — all three are needed for decryption
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedString: string): string {
  const key = getKey();
  const [ivHex, authTagHex, ciphertext] = encryptedString.split(':');

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted string format. Expected "iv:authTag:ciphertext".');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
