/**
 * Fetch wrapper for the Express API.
 *  - Access token lives only in memory (never localStorage).
 *  - The refresh token is an httpOnly cookie; on a 401 we refresh once
 *    (single-flight) and retry.
 *  - Errors become ApiError with the server's friendly message.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setOnSessionLost = (fn: () => void) => {
  onSessionLost = fn;
};

type RefreshResult = {
  accessToken: string;
  user: { id: string; name: string; role: 'caregiver' | 'patient' };
};
type SessionRole = 'caregiver' | 'patient';
let currentRole: SessionRole | null = null;
/** Which role this tab is signed in as (each role has its own refresh cookie). */
export const setSessionRole = (r: SessionRole | null) => {
  currentRole = r;
};
export const getSessionRole = () => currentRole;

const refreshing = new Map<string, Promise<RefreshResult | null>>();

/**
 * Single-flight refresh for one role (or the current role). Resolves null
 * when there is no valid session for it.
 */
export function refreshSession(role: SessionRole | null = currentRole): Promise<RefreshResult | null> {
  const key = role ?? 'any';
  let p = refreshing.get(key);
  if (!p) {
    p = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(role ? { role } : {}),
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as RefreshResult;
        accessToken = data.accessToken;
        currentRole = data.user.role;
        return data;
      })
      .catch(() => null)
      .finally(() => {
        refreshing.delete(key);
      });
    refreshing.set(key, p);
  }
  return p;
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

async function rawFetch(path: string, opts: Options): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetch(path, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'include',
    signal: opts.signal,
  });
}

async function withAuth(path: string, opts: Options): Promise<Response> {
  let res: Response;
  try {
    res = await rawFetch(path, opts);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Please check the connection.');
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const ok = await refreshSession();
    if (ok) res = await rawFetch(path, opts);
    else onSessionLost?.();
  }
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const data = await res.json();
    return new ApiError(
      res.status,
      data?.error?.code ?? 'ERROR',
      data?.error?.message ?? 'Something went wrong.',
      data?.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'ERROR', 'Something went wrong. Please try again.');
  }
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const res = await withAuth(path, opts);
  // 422 from photo enrollment still carries a useful body.
  if (!res.ok && res.status !== 422) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Authenticated binary download (photos, exports). */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await withAuth(path, {});
  if (!res.ok) throw await toError(res);
  return res.blob();
}

/** Saves a Blob as a file download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
