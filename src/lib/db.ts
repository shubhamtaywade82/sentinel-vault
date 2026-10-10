import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/generated/prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaLibSql({ url: process.env.DATABASE_URL ?? '' }),
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
