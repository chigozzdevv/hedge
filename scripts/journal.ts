import { loadEnvironment } from "./hedge.js";

loadEnvironment();
const { readRecord, writeRecord, recordKeys } = await import(
  "../server/src/shared/database/records.js"
);
const { connectDatabase, closeDatabase } = await import(
  "../server/src/shared/database/database.client.js"
);
const [action, key] = process.argv.slice(2);
const scope = process.env["HEDGE_JOURNAL_SCOPE"];
if (
  !scope?.startsWith("deployment:") ||
  !(action === "list"
    ? key === "loan-*.json"
    : /^(?:(?:deploy|loan)-[a-z0-9-]+|deployment)\.json$/.test(key ?? "")) ||
  !["read", "write", "list"].includes(action ?? "")
)
  throw new Error("Invalid deployment journal request");
try {
  await connectDatabase();
  if (action === "list")
    process.stdout.write(
      JSON.stringify(
        (await recordKeys(scope)).filter((name) => /^loan-[a-z0-9-]+\.json$/.test(name)),
      ),
    );
  else if (action === "read")
    process.stdout.write(JSON.stringify((await readRecord(scope, key)) ?? null));
  else {
    let contents = "";
    for await (const chunk of process.stdin) contents += String(chunk);
    await writeRecord(scope, key, JSON.parse(contents));
  }
} finally {
  await closeDatabase();
}
