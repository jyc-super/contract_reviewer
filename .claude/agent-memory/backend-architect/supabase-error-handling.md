# Supabase Error Handling Patterns

## Error Code Inventory

| Code | HTTP | Trigger |
|---|---|---|
| `SUPABASE_UNREACHABLE` | 503 | TCP timeout (5s race) on insert or status query |
| `SUPABASE_SCHEMA_MISSING` | 503 | PG code PGRST205 / 42P01 or "schema cache" message |
| `SUPABASE_PERMISSION_DENIED` | 503 | PG code 42501 or "permission denied" in message |
| `SUPABASE_INSERT_FAILED` | 503 | Any other insert error not matched above |
| `SUPABASE_UNAVAILABLE` | 503 | `getAdminSupabaseClientIfAvailable()` returns null (no config) |

## Key Design Decisions

- `createClient()` is lazy — it never connects on construction, so `getAdminSupabaseClientIfAvailable()` returning non-null does NOT mean Supabase is reachable. The first actual network call is where connection failures surface.
- All Supabase network calls in hot paths (POST /api/contracts, GET /api/contracts/[id]/status) must be wrapped in a `Promise.race()` with a deadline (5s used consistently). Without this, unreachable Supabase causes ~600s OS TCP hang on Windows.
- The 5s timeout is applied in: (1) initial contract insert in POST /api/contracts, (2) status query in GET /api/contracts/[id]/status.

## Auth Timeout
- `lib/auth/server.ts` `getUserIdFromRequest()` imposes its own 4s timeout on `supabase.auth.getUser()`.
- In dev (`NODE_ENV !== "production"`), `requireUserIdFromRequest()` falls back to `PLACEHOLDER_USER_ID` when no token is present — no auth blocking in local dev.

## Path B (No Supabase)
- When `getAdminSupabaseClientIfAvailable()` returns null, POST /api/contracts falls through to Path B: synchronous parse, returns result inline (no DB persistence). Useful for local dev without Supabase configured.
