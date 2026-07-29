create extension if not exists vector;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Secret keys are stored hashed. key_prefix is the first 12 chars of the
-- plaintext, kept so a dashboard can show "sk_live_a1b2…" for identification
-- without ever storing anything that could authenticate a request.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_api_keys_tenant on public.api_keys (tenant_id);
