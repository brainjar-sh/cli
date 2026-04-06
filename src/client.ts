import { Errors } from 'incur'
import { basename, join } from 'node:path'
import { readConfig, activeContext, isLocalContext } from './config.js'
import type { ServerContext } from './config.js'
import { getBrainjarDir, getLocalDir } from './paths.js'
import { access, readFile } from 'node:fs/promises'
import { ensureRunning } from './daemon.js'
import { ErrorCode, createError } from './errors.js'

const { IncurError } = Errors

export interface ClientOptions {
  serverUrl?: string
  workspace?: string
  project?: string
  session?: string
  timeout?: number
}

export interface RequestOptions {
  timeout?: number
  headers?: Record<string, string>
  /** Pass a project name to scope to that project, null to suppress auto-detection, or undefined for auto-detect. */
  project?: string | null
}

export interface BrainjarClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  delete<T>(path: string, options?: RequestOptions): Promise<T>
}

const ERROR_MAP: Record<number, { code: ErrorCode; hint?: string }> = {
  400: { code: ErrorCode.BAD_REQUEST },
  401: { code: ErrorCode.UNAUTHORIZED, hint: 'Check your server configuration.' },
  404: { code: ErrorCode.NOT_FOUND },
  409: { code: ErrorCode.CONFLICT },
  422: { code: ErrorCode.VALIDATION_ERROR },
  500: { code: ErrorCode.SERVER_ERROR, hint: 'Check server logs at ~/.brainjar/server.log' },
  502: { code: ErrorCode.SERVER_ERROR, hint: 'Server may be starting up. Try again.' },
  503: { code: ErrorCode.SERVER_UNAVAILABLE, hint: 'Server is not ready. Try again in a moment.' },
}

async function resolveToken(ctx: ServerContext): Promise<string | null> {
  const envToken = process.env.BRAINJAR_TOKEN
  if (envToken) return envToken

  if (isLocalContext(ctx)) {
    const tokenFile = ctx.auth_token_file ?? join(getBrainjarDir(), 'auth-token')
    try {
      return (await readFile(tokenFile, 'utf-8')).trim()
    } catch {
      return null // token file doesn't exist yet (server not started)
    }
  }

  if (ctx.token) return ctx.token

  return null
}

export async function detectProject(explicit?: string | null): Promise<string | null> {
  if (explicit === null) return null // explicitly suppress auto-detection
  if (explicit) return explicit
  try {
    await access(getLocalDir())
    return basename(process.cwd())
  } catch {
    return null
  }
}

/**
 * Create a client instance bound to the current config.
 */
export async function createClient(options?: ClientOptions): Promise<BrainjarClient> {
  const config = await readConfig()
  const ctx = activeContext(config)
  const serverUrl = (options?.serverUrl ?? ctx.url).replace(/\/$/, '')
  const workspace = options?.workspace ?? ctx.workspace
  const session = options?.session ?? process.env.BRAINJAR_SESSION ?? null
  const defaultTimeout = options?.timeout ?? 10_000
  const mode = ctx.mode

  async function request<T>(method: string, path: string, body?: unknown, reqOpts?: RequestOptions): Promise<T> {
    const url = `${serverUrl}${path}`
    const timeout = reqOpts?.timeout ?? defaultTimeout

    const token = await resolveToken(ctx)

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Brainjar-Workspace': workspace,
      ...(reqOpts?.headers ?? {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const explicitProject = reqOpts && 'project' in reqOpts ? reqOpts.project : options?.project
    const project = await detectProject(explicitProject)
    if (project) headers['X-Brainjar-Project'] = project
    if (session) headers['X-Brainjar-Session'] = session

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        throw createError(ErrorCode.TIMEOUT, {
          message: `Request timed out after ${timeout}ms`,
        })
      }
      const hint = mode === 'local'
        ? "Run 'brainjar server start' or 'brainjar init'."
        : `Check the URL or run 'brainjar server remote <url>'.`
      throw createError(ErrorCode.SERVER_UNREACHABLE, {
        params: [serverUrl],
        hint,
      })
    }

    if (!response.ok) {
      let serverError: { error?: string | { code?: string; message?: string }; code?: string; message?: string } | null = null
      try {
        serverError = await response.json()
      } catch {}

      const mapped = ERROR_MAP[response.status]

      // Handle both flat { error: "msg", code: "X" } and nested { error: { code: "X", message: "msg" } }
      let code: string
      let message: string
      if (serverError?.error && typeof serverError.error === 'object') {
        code = serverError.error.code ?? mapped?.code ?? ErrorCode.API_ERROR
        message = serverError.error.message ?? `Server returned ${response.status}`
      } else {
        code = serverError?.code ?? mapped?.code ?? ErrorCode.API_ERROR
        message = (typeof serverError?.error === 'string' ? serverError.error : null)
          ?? serverError?.message
          ?? `Server returned ${response.status}`
      }
      const hint = mapped?.hint

      throw new IncurError({ code, message, hint })
    }

    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  return {
    get<T>(path: string, options?: RequestOptions) {
      return request<T>('GET', path, undefined, options)
    },
    post<T>(path: string, body?: unknown, options?: RequestOptions) {
      return request<T>('POST', path, body, options)
    },
    put<T>(path: string, body?: unknown, options?: RequestOptions) {
      return request<T>('PUT', path, body, options)
    },
    delete<T>(path: string, options?: RequestOptions) {
      return request<T>('DELETE', path, undefined, options)
    },
  }
}

/**
 * Ensure the server is running and return a connected client.
 * Convenience wrapper — commands should use this instead of calling
 * ensureRunning() + createClient() separately.
 */
export async function getApi(options?: ClientOptions): Promise<BrainjarClient> {
  await ensureRunning()
  return createClient(options)
}
