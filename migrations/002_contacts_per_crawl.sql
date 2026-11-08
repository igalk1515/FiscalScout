-- A crawl covers one entity, which can span several hosts (www.boerneisd.net and
-- boerneisd.smartsiteshost.com). A person is one contact per crawl, whatever host named them.
delete from contacts a using contacts b
  where a.crawl_id = b.crawl_id and a.name = b.name and a.id > b.id;
alter table contacts drop constraint if exists contacts_crawl_id_host_name_key;
alter table contacts add constraint contacts_crawl_id_name_key unique (crawl_id, name);
create index contacts_email_idx on contacts (crawl_id, email);
