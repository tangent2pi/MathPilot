-- Replace kind/query/limit/offset only. The PostgreSQL session identity fixes tenant scope.
select jsonb_pretty(agmath_agent_library('questions', '', 20, 0));
