const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const result = await p.user.updateMany({ data: { role: 'admin' } });
  console.log('Updated', result);
}

main().finally(() => p.$disconnect());
