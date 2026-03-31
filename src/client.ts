import { Errors } from 'incur'
import { basename } from 'node:path'
import { readConfig } from './config.js'
import { getLocalDir } from './paths.js'
import { access } from 'node:fs/promises'
import { ensureRunning } from './daemon.js'

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
  project?: string
}

export interface BrainjarClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  delete<T>(path: string, options?: RequestOptions): Promise<T>
}

const ERROR_MAP: Record<number, { code: string; hint?: string }> = {
  400: { code: 'BAD_REQUEST' },
  401: { code: 'UNAUTHORIZED', hint: 'Check your server configuration.' },
  404: { code: 'NOT_FOUND' },
  409: { code: 'CONFLICT' },
  422: { code: 'VALIDATION_ERROR' },
  500: { code: 'SERVER_ERROR', hint: 'Check server logs at ~/.brainjar/server.log' },
  502: { code: 'SERVER_ERROR', hint: 'Server may be starting up. Try again.' },
  503: { code: 'SERVER_UNAVAILABLE', hint: 'Server is not ready. Try again in a moment.' },
}

async function detectProject(explicit?: string): Promise<string | null> {
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
  const serverUrl = (options?.serverUrl ?? config.server.url).replace(/\/$/, '')
  const workspace = options?.workspace ?? config.workspace
  const session = options?.session ?? process.env.BRAINJAR_SESSION ?? null
  const defaultTimeout = options?.timeout ?? 10_000
  const mode = config.server.mode

  async function request<T>(method: string, path: string, body?: unknown, reqOpts?: RequestOptions): Promise<T> {
    const url = `${serverUrl}${path}`
    const timeout = reqOpts?.timeout ?? defaultTimeout

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Brainjar-Workspace': workspace,
      ...(reqOpts?.headers ?? {}),
    }

    const project = await detectProject(reqOpts?.project ?? options?.project)
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
        throw new IncurError({
          code: 'TIMEOUT',
          message: `Request timed out after ${timeout}ms`,
        })
      }
      const hint = mode === 'local'
        ? "Run 'brainjar server start' or 'brainjar init'."
        : `Check the URL or run 'brainjar server remote <url>'.`
      throw new IncurError({
        code: 'SERVER_UNREACHABLE',
        message: `Cannot reach server at ${serverUrl}`,
        hint,
      })
    }

    if (!response.ok) {
      let serverError: { error?: string; code?: string } | null = null
      try {
        serverError = await response.json()
      } catch {}

      const mapped = ERROR_MAP[response.status]
      const code = serverError?.code ?? mapped?.code ?? 'API_ERROR'
      const message = serverError?.error ?? `Server returned ${response.status}`
      const hint = mapped?.hint

      throw new IncurError({ code, message, hint })
    }

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
