// Supabase REST (PostgREST) with the service role key, plain fetch: no SDK.

// Node (GitHub Actions) or Deno (the link-request Edge Function), read when first needed.
// deno-lint-ignore no-explicit-any
const runtime = globalThis as any;
const env = (name: string): string | undefined => runtime.process?.env?.[name] ?? runtime.Deno?.env.get(name);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  // the anon key reads the public tables only: enough for the read-only checks (tools/verify.py)
  const key = env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_ANON_KEY');
  if (!env('SUPABASE_URL') || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

// a dropped connection is tried again, twice, 5 then 20 s later (12/11/2026: one ECONNRESET stopped a 5-hour sweep)
async function send(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<Response> {
  for (const wait of [5_000, 20_000, 0]) {
    try {
      return await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
        method,
        headers: headers(extra),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (!wait) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}

async function call<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const res = await send(method, path, body, extra);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const select = <T>(path: string) => call<T[]>('GET', path);

/** Every row, 1000 at a time: the API returns at most 1000 rows per call. `path` must set an order. */
export async function selectAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await select<T>(`${path}&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export const insert = <T>(table: string, rows: unknown) =>
  call<T[]>('POST', table, rows, { Prefer: 'return=representation' });

export const upsert = <T>(table: string, rows: unknown, onConflict: string) =>
  call<T[]>('POST', `${table}?on_conflict=${onConflict}`, rows, {
    Prefer: 'resolution=merge-duplicates,return=representation',
  });

export const update = (table: string, filter: string, patch: unknown) =>
  call<null>('PATCH', `${table}?${filter}`, patch, { Prefer: 'return=minimal' });

export const remove = (table: string, filter: string) =>
  call<null>('DELETE', `${table}?${filter}`, undefined, { Prefer: 'return=minimal' });

export const rpc = <T>(fn: string, args: unknown) => call<T[]>('POST', `rpc/${fn}`, args);
