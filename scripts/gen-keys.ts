// Prints fresh random keys for .env (JWT_SECRET, SECRET_ENC_KEY).
import { randomBytes } from 'node:crypto';

console.log(`JWT_SECRET=${randomBytes(48).toString('base64url')}`);
console.log(`SECRET_ENC_KEY=${randomBytes(32).toString('base64')}`);
console.log('\nPaste these into .env. Back up SECRET_ENC_KEY safely.');
