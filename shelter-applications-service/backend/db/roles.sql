-- Least privilege for the Lambda's database login (run once as the owner in the Neon SQL Editor).
-- The API can read/insert/update applications and append events; it cannot DELETE,
-- DROP, ALTER or TRUNCATE anything. Put the app_api connection string in Secrets Manager.
-- Create app_api in SQL with a private 24+ character random password before running this file.
-- Do not use Neon Console's Add role: Console-created roles inherit neon_superuser.
-- CREATE ROLE app_api WITH LOGIN PASSWORD '<long random password>';
DO $$
BEGIN
  IF pg_has_role('app_api', 'neon_superuser', 'MEMBER') THEN
    RAISE EXCEPTION 'app_api has neon_superuser membership; create it with SQL instead';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO app_api;
GRANT SELECT, INSERT, UPDATE ON applications TO app_api;
GRANT SELECT, INSERT ON application_events TO app_api;
