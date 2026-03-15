import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bitwarden, bw, loadSession } from '../src/engines/bitwarden.js'

let tempDir: string
let origSession: string | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bw-test-'))
  origSession = process.env.BW_SESSION
  process.env.BRAINJAR_HOME = tempDir
  delete process.env.BW_SESSION
})

afterEach(async () => {
  if (origSession !== undefined) {
    process.env.BW_SESSION = origSession
  } else {
    delete process.env.BW_SESSION
  }
  delete process.env.BRAINJAR_HOME
  await rm(tempDir, { recursive: true, force: true })
})

// ── loadSession() ───────────────────────────────────────────────────

describe('loadSession', () => {
  test('returns BW_SESSION env var when set', async () => {
    process.env.BW_SESSION = 'env-token'
    await writeFile(join(tempDir, '.session'), 'file-token')

    expect(await loadSession()).toBe('env-token')
  })

  test('returns session from file when env var not set', async () => {
    await writeFile(join(tempDir, '.session'), 'file-token')

    expect(await loadSession()).toBe('file-token')
  })

  test('trims whitespace from session file', async () => {
    await writeFile(join(tempDir, '.session'), '  file-token  \n')

    expect(await loadSession()).toBe('file-token')
  })

  test('returns null when neither env var nor file exists', async () => {
    expect(await loadSession()).toBeNull()
  })

  test('returns null when file is empty', async () => {
    await writeFile(join(tempDir, '.session'), '   \n  ')

    expect(await loadSession()).toBeNull()
  })
})

// ── status() ────────────────────────────────────────────────────────

describe('bitwarden.status()', () => {
  test('returns not_installed when bw binary missing', async () => {
    spyOn(bw, 'whichBw').mockRejectedValue(new Error('not found'))

    const result = await bitwarden.status()
    expect(result.state).toBe('not_installed')
    expect((result as any).install).toBe('npm install -g @bitwarden/cli')
  })

  test('returns unauthenticated when bw reports unauthenticated', async () => {
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockResolvedValue({
      status: 'unauthenticated',
      userEmail: 'user@example.com',
    })

    const result = await bitwarden.status()
    expect(result.state).toBe('unauthenticated')
    expect((result as any).operator_action).toContain('bw login')
    expect((result as any).operator_action).toContain('user@example.com')
  })

  test('returns unauthenticated with placeholder when no email', async () => {
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockResolvedValue({ status: 'unauthenticated' })

    const result = await bitwarden.status()
    expect(result.state).toBe('unauthenticated')
    expect((result as any).operator_action).toContain('<email>')
  })

  test('returns unlocked with session when vault is unlocked and session exists', async () => {
    process.env.BW_SESSION = 'my-session'
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockResolvedValue({ status: 'unlocked' })

    const result = await bitwarden.status()
    expect(result.state).toBe('unlocked')
    expect((result as any).session).toBe('my-session')
  })

  test('returns locked when vault reports unlocked but no session available', async () => {
    // No session env or file
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockResolvedValue({ status: 'unlocked' })

    const result = await bitwarden.status()
    expect(result.state).toBe('locked')
  })

  test('returns locked when vault is locked', async () => {
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockResolvedValue({ status: 'locked' })

    const result = await bitwarden.status()
    expect(result.state).toBe('locked')
    expect((result as any).operator_action).toContain('bw unlock')
  })

  test('returns locked with error context when bw status throws', async () => {
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    spyOn(bw, 'status').mockRejectedValue(new Error('connection refused'))

    const result = await bitwarden.status()
    expect(result.state).toBe('locked')
    expect((result as any).operator_action).toContain('Could not determine')
  })

  test('passes session to bw.status when available', async () => {
    process.env.BW_SESSION = 'test-session'
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    const statusSpy = spyOn(bw, 'status').mockResolvedValue({ status: 'unlocked' })

    await bitwarden.status()
    expect(statusSpy).toHaveBeenCalledWith('test-session')
  })

  test('passes null to bw.status when no session', async () => {
    spyOn(bw, 'whichBw').mockResolvedValue(undefined)
    const statusSpy = spyOn(bw, 'status').mockResolvedValue({ status: 'locked' })

    await bitwarden.status()
    expect(statusSpy).toHaveBeenCalledWith(null)
  })
})

// ── get() ───────────────────────────────────────────────────────────

describe('bitwarden.get()', () => {
  test('returns password from login item', async () => {
    spyOn(bw, 'getItem').mockResolvedValue({
      login: { password: 's3cret' },
      notes: null,
    })

    const result = await bitwarden.get('my-item', 'test-session')
    expect(result).toEqual({ value: 's3cret' })
  })

  test('prefers password over notes', async () => {
    spyOn(bw, 'getItem').mockResolvedValue({
      login: { password: 'the-password' },
      notes: 'some-notes',
    })

    const result = await bitwarden.get('my-item', 'test-session')
    expect(result).toEqual({ value: 'the-password' })
  })

  test('returns notes when no password', async () => {
    spyOn(bw, 'getItem').mockResolvedValue({
      login: null,
      notes: 'my-api-key-from-notes',
    })

    const result = await bitwarden.get('my-item', 'test-session')
    expect(result).toEqual({ value: 'my-api-key-from-notes' })
  })

  test('returns error when item has neither password nor notes', async () => {
    spyOn(bw, 'getItem').mockResolvedValue({
      login: { password: null },
      notes: null,
    })

    const result = await bitwarden.get('empty-item', 'test-session')
    expect((result as any).error).toContain('empty-item')
    expect((result as any).error).toContain('no password or notes')
  })

  test('returns error message from stderr on failure', async () => {
    const err: any = new Error('command failed')
    err.stderr = Buffer.from('Not found.')
    spyOn(bw, 'getItem').mockRejectedValue(err)

    const result = await bitwarden.get('missing-item', 'test-session')
    expect((result as any).error).toContain('missing-item')
    expect((result as any).error).toContain('Not found.')
  })

  test('falls back to error message when no stderr', async () => {
    spyOn(bw, 'getItem').mockRejectedValue(new Error('network timeout'))

    const result = await bitwarden.get('my-item', 'test-session')
    expect((result as any).error).toContain('network timeout')
  })

  test('passes item and session to bw.getItem', async () => {
    const spy = spyOn(bw, 'getItem').mockResolvedValue({
      login: { password: 'x' },
    })

    await bitwarden.get('target-item', 'my-session')
    expect(spy).toHaveBeenCalledWith('target-item', 'my-session')
  })

  test('rejects empty item name', async () => {
    const result = await bitwarden.get('', 'test-session')
    expect((result as any).error).toContain('Invalid item name')
  })

  test('rejects item name with control characters', async () => {
    const result = await bitwarden.get('item\x00name', 'test-session')
    expect((result as any).error).toContain('Invalid item name')
  })

  test('rejects item name exceeding 256 characters', async () => {
    const result = await bitwarden.get('a'.repeat(257), 'test-session')
    expect((result as any).error).toContain('Invalid item name')
  })
})

// ── lock() ──────────────────────────────────────────────────────────

describe('bitwarden.lock()', () => {
  test('succeeds when bw lock succeeds', async () => {
    spyOn(bw, 'lock').mockResolvedValue(undefined)

    // Should not throw
    await bitwarden.lock()
  })

  test('throws with stderr message on failure', async () => {
    const err: any = new Error('command failed')
    err.stderr = Buffer.from('Vault is not unlocked.')
    spyOn(bw, 'lock').mockRejectedValue(err)

    await expect(bitwarden.lock()).rejects.toThrow('Failed to lock vault')
    // Re-spy since the previous was consumed
    const err2: any = new Error('command failed')
    err2.stderr = Buffer.from('Vault is not unlocked.')
    spyOn(bw, 'lock').mockRejectedValue(err2)
    await expect(bitwarden.lock()).rejects.toThrow('Vault is not unlocked.')
  })

  test('throws with error message when no stderr', async () => {
    spyOn(bw, 'lock').mockRejectedValue(new Error('connection refused'))

    await expect(bitwarden.lock()).rejects.toThrow('Failed to lock vault: connection refused')
  })
})
