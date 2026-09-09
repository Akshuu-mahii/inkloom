-- Runs once when the postgres volume is first created.
-- Creates an isolated database for the integration/concurrency test suite so
-- `pnpm test` can never touch the database used by `pnpm dev`.
CREATE DATABASE inkloom_test OWNER inkloom;
