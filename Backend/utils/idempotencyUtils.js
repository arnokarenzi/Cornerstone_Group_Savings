"use strict";

const crypto = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function requestHash(req) {
  return crypto.createHash("sha256").update(stable({
    method: String(req.method).toUpperCase(),
    path: String(req.originalUrl || req.path),
    body: req.body || {},
  })).digest("hex");
}

module.exports = { stable, requestHash };
