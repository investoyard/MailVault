-- One-time: creates the MailVault role and database on the shared Postgres server.
-- Run through scripts/setup-db.ps1 (passes :app_password).
SELECT 'CREATE ROLE mailvault LOGIN PASSWORD ' || quote_literal(:'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailvault')
\gexec

ALTER ROLE mailvault PASSWORD :'app_password';
-- CREATEDB lets "prisma migrate dev" create its temporary shadow database.
ALTER ROLE mailvault CREATEDB;

SELECT 'CREATE DATABASE mailvault OWNER mailvault ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mailvault')
\gexec

\connect mailvault
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO mailvault;
