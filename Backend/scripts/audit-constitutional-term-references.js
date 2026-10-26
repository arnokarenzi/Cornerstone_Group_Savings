"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const monitoredFiles = [
  "Frontend/src/components/MemberFinance.jsx",
  "Frontend/src/components/LoanOperations.jsx",
  "Frontend/src/components/FinancialRequests.jsx",
  "Frontend/src/components/ConstitutionManagement.jsx",
  "Backend/services/loanService.js",
  "Backend/services/loanApplicationService.js",
  "Backend/services/loanRestructuringService.js",
];

const forbiddenReferences = [
  {
    label: "hard-coded 28-day service-charge statement",
    pattern: /(?:every|each|per)\s+28\s+days|28-day\s+service-charge\s+period/i,
  },
  {
    label: "hard-coded 180-day maximum loan term statement",
    pattern: /(?:maximum|max)\s+(?:initial\s+)?loan term[^\n.]{0,80}\b180\s+days?\b/i,
  },
  {
    label: "hard-coded 10% charge statement paired with a fixed day period",
    pattern: /\b10(?:\.0+)?%\s+(?:service charge|interest)[^\n.]{0,120}\b(?:28|180)\s+days?\b/i,
  },
];

const errors = [];
for (const relativePath of monitoredFiles) {
  const fullPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    errors.push(`${relativePath}: required file is missing.`);
    continue;
  }
  const source = fs.readFileSync(fullPath, "utf8");
  for (const reference of forbiddenReferences) {
    const match = reference.pattern.exec(source);
    if (match) {
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(`${relativePath}:${line}: ${reference.label}. Read the current approved Constitution & Rules instead.`);
    }
  }
}

const serviceFiles = [
  "Backend/services/loanService.js",
  "Backend/services/loanApplicationService.js",
  "Backend/services/loanRestructuringService.js",
];
for (const relativePath of serviceFiles) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  if (/DEFAULT_LOAN_SETTINGS\.(?:interestRate|interestPeriodDays|maxLoanTermDays)|DEFAULT_CONSTITUTION\.(?:interestRate|interestPeriodDays|maxLoanTermDays)/.test(source)) {
    errors.push(`${relativePath}: runtime loan handling falls back to the initial default for service-charge terms. Missing current constitutional settings must fail closed.`);
  }
}

if (errors.length) {
  console.error("Constitutional loan-term reference audit FAILED:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("PASS: member-facing loan statements are dynamic, and runtime loan workflows do not fall back to hard-coded initial loan terms.");
  console.log("Note: initial values remain intentionally defined for fresh-company provisioning and the Constitution & Rules form; they are not runtime loan-term fallbacks.");
}
