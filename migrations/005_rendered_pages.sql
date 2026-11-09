-- The render tier: a page drawn by scripts that was opened in a headless browser.
-- needs_browser says the plain fetch was an empty shell; rendered says the browser read it.
alter table pages add column if not exists rendered boolean not null default false;
