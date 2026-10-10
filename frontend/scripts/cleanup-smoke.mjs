import { db } from '../src/lib/db.ts'

const smokeClients = await db.serviceClient.findMany({ where: { name: { startsWith: 'smoke' } } })
for (const c of smokeClients) {
  await db.secretAccessGrant.deleteMany({ where: { serviceClientId: c.id } })
  await db.secretAccessEvent.deleteMany({ where: { actorClientId: c.id } })
  await db.serviceClient.delete({ where: { id: c.id } })
}
const smokeSecrets = await db.vaultSecret.findMany({
  where: { OR: [{ path: { startsWith: 'smoke/' } }, { name: { startsWith: 'smoke' } }] },
})
for (const s of smokeSecrets) {
  await db.secretAccessGrant.deleteMany({ where: { vaultSecretId: s.id } })
  await db.secretAccessEvent.deleteMany({ where: { vaultSecretId: s.id } })
  await db.connectionSecretBinding.deleteMany({ where: { vaultSecretId: s.id } })
  await db.secretVersion.deleteMany({ where: { vaultSecretId: s.id } })
  await db.vaultSecret.delete({ where: { id: s.id } })
}
const smokeConns = await db.integrationConnection.findMany({
  where: { OR: [{ providerKey: 'smoke' }, { providerAccountRef: { startsWith: 'SMOKE' } }] },
})
for (const c of smokeConns) {
  await db.connectionSecretBinding.deleteMany({ where: { connectionId: c.id } })
  await db.rotationRun.deleteMany({ where: { connectionId: c.id } })
  await db.integrationConnection.delete({ where: { id: c.id } })
}
console.log('Cleaned:', {
  smokeClients: smokeClients.length,
  smokeSecrets: smokeSecrets.length,
  smokeConns: smokeConns.length,
})
process.exit(0)
