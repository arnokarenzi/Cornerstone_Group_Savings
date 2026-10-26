"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ignoredDirs = new Set(["node_modules", ".git"]);
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(path.join(directory, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.join(directory, entry.name));
    }
  }
}
walk(root);
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`Syntax failed: ${path.relative(root, file)}\n${result.stderr || result.stdout}`);
  }
}
if (failures) process.exit(1);
console.log(`Syntax check passed for ${files.length} backend JavaScript files.`);
