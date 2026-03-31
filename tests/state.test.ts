import { describe, test, expect } from 'bun:test'
import { normalizeSlug } from '../src/state.js'

describe('normalizeSlug', () => {
  test('returns valid slugs unchanged', () => {
    expect(normalizeSlug('personal', 'test')).toBe('personal')
    expect(normalizeSlug('work-dev', 'test')).toBe('work-dev')
    expect(normalizeSlug('my_soul', 'test')).toBe('my_soul')
    expect(normalizeSlug('v2', 'test')).toBe('v2')
    expect(normalizeSlug('A-Z_09', 'test')).toBe('A-Z_09')
  })

  test('strips .md extension', () => {
    expect(normalizeSlug('my-soul.md', 'test')).toBe('my-soul')
    expect(normalizeSlug('tech-lead.md', 'test')).toBe('tech-lead')
  })

  test('rejects path traversal', () => {
    expect(() => normalizeSlug('../../../etc/cron.d/evil', 'test')).toThrow('Invalid test')
  })

  test('rejects dots (non-.md)', () => {
    expect(() => normalizeSlug('some.thing', 'test')).toThrow('Invalid test')
    expect(() => normalizeSlug('file.txt', 'test')).toThrow('Invalid test')
  })

  test('rejects slashes', () => {
    expect(() => normalizeSlug('a/b', 'test')).toThrow()
    expect(() => normalizeSlug('a\\b', 'test')).toThrow()
  })

  test('rejects spaces', () => {
    expect(() => normalizeSlug('my soul', 'test')).toThrow()
  })

  test('rejects empty string', () => {
    expect(() => normalizeSlug('', 'test')).toThrow()
  })

  test('includes label in error message', () => {
    expect(() => normalizeSlug('bad!name', 'soul name')).toThrow('Invalid soul name')
  })
})
