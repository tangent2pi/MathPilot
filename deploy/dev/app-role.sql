-- The shared application role must exist before historical migrations that
-- grant to it. Domain users and final grants remain in bootstrap.sql.
select format('create role %I login password %L', 'mathpilot_app', :'app_password')
 where not exists (select from pg_roles where rolname = 'mathpilot_app') \gexec
alter role mathpilot_app password :'app_password';
