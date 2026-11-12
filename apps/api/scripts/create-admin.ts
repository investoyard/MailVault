// Creates or resets a local Super Admin.
// Usage: npm run create-admin -- <username> <password> ["Display Name"]
import '../src/env.js';
import bcrypt from 'bcryptjs';
import { prisma } from '@mailvault/db';

const [username, password, displayName] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run create-admin -- <username> <password> ["Display Name"]');
  process.exit(1);
}
if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
  console.error('Use a password of at least 10 characters with letters and numbers.');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);
const user = await prisma.user.upsert({
  where: { username: username.toLowerCase() },
  create: {
    username: username.toLowerCase(),
    displayName: displayName ?? 'Administrator',
    passwordHash,
    role: 'SUPER_ADMIN',
  },
  update: { passwordHash, isActive: true, role: 'SUPER_ADMIN' },
});
await prisma.auditLog.create({ data: { action: 'ADMIN_CREATED_BY_SCRIPT', entityType: 'User', entityId: user.id } });
console.log(`Super Admin '${user.username}' is ready.`);
await prisma.$disconnect();
