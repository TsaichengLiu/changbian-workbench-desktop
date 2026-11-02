const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const electronPath = require("electron");
const testsDirectory = path.join(__dirname, "..", "tests");
const testFiles = fs
  .readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => path.join(testsDirectory, name));

const result = spawnSync(electronPath, ["--test", ...testFiles], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
