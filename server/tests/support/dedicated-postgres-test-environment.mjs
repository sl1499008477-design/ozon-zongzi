// Must be imported before application modules, including env.mjs.
const databaseUrl = process.env.SONLI_POSTGRES_TESTS === "1"
  ? process.env.SONLI_MIGRATION_TEST_DATABASE_URL : "";
for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_URL$|POSTGRES_|PG)/.test(key)) delete process.env[key];
}
process.env.QH_LOCAL_NO_DOTENV = "1";
process.env.QH_LOCAL_NO_LISTEN = "1";
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
} else {
  delete process.env.SONLI_MIGRATION_TEST_DATABASE_URL;
}
