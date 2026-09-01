-- The shared application role must exist before historical migrations that
-- grant to it. Domain users and final grants remain in bootstrap.sql.
select format('create role %I login password %L', 'mathpilot_app', :'app_password')
 where not exists (select from pg_roles where rolname = 'mathpilot_app') \gexec
alter role mathpilot_app password :'app_password';

-- Storage is the only online owner allowed to mutate object lifecycle rows or
-- lease cross-tenant garbage collection work. It deliberately has neither
-- inheritance nor RLS bypass.
select format(
  'create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
  'mathpilot_storage', :'storage_password'
)
 where not exists (select from pg_roles where rolname = 'mathpilot_storage') \gexec
alter role mathpilot_storage noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'storage_password';
select format('grant connect on database %I to mathpilot_storage',current_database()) \gexec
