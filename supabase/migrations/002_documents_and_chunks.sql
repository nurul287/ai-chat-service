create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  external_id text not null,
  title text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create index idx_documents_tenant on public.documents (tenant_id);

create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1024) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now()
);

create index idx_chunks_tenant on public.chunks (tenant_id);
create index idx_chunks_document on public.chunks (document_id);
create index idx_chunks_fts on public.chunks using gin (fts);
create index idx_chunks_embedding on public.chunks using hnsw (embedding vector_cosine_ops);
