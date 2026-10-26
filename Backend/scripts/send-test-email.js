"use strict";

require("dotenv").config();
const { sendTestEmail, assertEmailProviderConfiguration } = require("../services/emailService");

async function main() {
  const to = String(process.argv[2] || process.env.EMAIL_TEST_TO || "").trim();
  const config = assertEmailProviderConfiguration(process.env);
  if (config.provider !== "resend") {
    throw new Error("A live test requires EMAIL_PROVIDER=resend and a valid RESEND_API_KEY. Console mode does not deliver email.");
  }
  if (!to) throw new Error("Provide a test recipient: npm run email:test -- recipient@example.com");

  const result = await sendTestEmail({ to });
  console.log("PASS: the Resend HTTPS API accepted a test email request.");
  console.log(`Recipient: ${to}`);
  if (result.messageId) console.log(`Provider message ID: ${result.messageId}`);
  console.log("Check the recipient inbox and spam folder, then confirm delivery in the Resend dashboard.");
}

main().catch((error) => {
  console.error(`Email delivery test FAILED: ${error.code || error.message}`);
  process.exitCode = 1;
});
