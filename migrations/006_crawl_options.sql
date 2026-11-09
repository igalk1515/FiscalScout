-- Keep the existing behavior for older crawls and clients that omit these options.
alter table crawls
  add column respect_robots boolean not null default true,
  add column use_llm boolean not null default true;
