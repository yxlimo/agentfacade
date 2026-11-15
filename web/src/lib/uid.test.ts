import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { newUid } from '@/lib/uid'

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newUid', () => {
  it('生成合法的 v4 形状 UUID，两次不一样', () => {
    const a = newUid()
    const b = newUid()
    expect(a).toMatch(UUID_SHAPE)
    expect(b).toMatch(UUID_SHAPE)
    expect(a).not.toBe(b)
  })

  it('没有 randomUUID 时退回 getRandomValues，仍是合法 UUID 形状且不重复', () => {
    const original = globalThis.crypto.randomUUID
    // 模拟非安全上下文：randomUUID 不存在。
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    })
    try {
      const a = newUid()
      const b = newUid()
      expect(a).toMatch(UUID_SHAPE)
      expect(b).toMatch(UUID_SHAPE)
      expect(a).not.toBe(b)
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: original,
        configurable: true,
      })
    }
  })

  it('没有任何 crypto API 也不抛，同一毫秒内连续取也不重号', () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    })
    try {
      const a = newUid()
      const b = newUid()
      expect(a).toBeTypeOf('string')
      expect(b).toBeTypeOf('string')
      expect(a).not.toBe(b)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
      })
    }
  })

  it('web/src/features 里不许再直接调 crypto.randomUUID', () => {
    const root = join(process.cwd(), 'src', 'features')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (readFileSync(path, 'utf8').includes('crypto.randomUUID')) {
          offenders.push(path)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
