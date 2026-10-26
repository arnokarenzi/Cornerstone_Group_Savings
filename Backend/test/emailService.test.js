const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendApprovalEmail,
  sendTestEmail,
  assertEmailProviderConfiguration,
} = require("../services/emailService");

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_FROM", "PUBLIC_APP_URL"];
function saveEnvironment() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}
function restoreEnvironment(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
function setEnvironment(overrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
}
const resendEnv = {
  NODE_ENV: "production",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_secret_key_not_real",
  EMAIL_FROM: "CORNESTONE Co.LTD. <no-reply@cornestone.rw>",
  PUBLIC_APP_URL: "https://members.cornestone.rw",
};

test("verification emails use the HTTPS Resend API with a bearer key and correctly composed message", async () => {
  const savedEnv = saveEnvironment();
  const originalFetch = global.fetch;
  let request;
  try {
    setEnvironment(resendEnv);
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ id: "email_test_123" }) };
    };

    const result = await sendVerificationEmail({ to: "member@example.net", fullName: "A Member", token: "abc123" });
    assert.equal(result.mode, "resend");
    assert.equal(result.messageId, "email_test_123");
    assert.equal(request.url, "https://api.resend.com/emails");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, `Bearer ${resendEnv.RESEND_API_KEY}`);
    assert.equal(request.body.from, resendEnv.EMAIL_FROM);
    assert.deepEqual(request.body.to, ["member@example.net"]);
    assert.match(request.body.text, /https:\/\/members\.cornestone\.rw\/verify-email\?token=abc123/);
    assert.match(request.body.html, /Verify email address/);
  } finally {
    global.fetch = originalFetch;
    restoreEnvironment(savedEnv);
  }
});

test("password reset and committee approval emails are sent by the configured API", async () => {
  const savedEnv = saveEnvironment();
  const originalFetch = global.fetch;
  const requests = [];
  try {
    setEnvironment(resendEnv);
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ id: `email_${requests.length}` }) };
    };

    await sendPasswordResetEmail({ to: "member@example.net", fullName: "Member", token: "reset-token" });
    await sendApprovalEmail({ to: "member@example.net", fullName: "Member", approved: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].subject, "Reset your CORNESTONE password");
    assert.match(requests[0].text, /expires in 30 minutes/);
    assert.equal(requests[1].subject, "Your CORNESTONE account is approved");
  } finally {
    global.fetch = originalFetch;
    restoreEnvironment(savedEnv);
  }
});

test("provider errors are surfaced without exposing the raw provider body or API key", async () => {
  const savedEnv = saveEnvironment();
  const originalFetch = global.fetch;
  try {
    setEnvironment(resendEnv);
    global.fetch = async () => ({
      ok: false,
      status: 422,
      json: async () => ({ name: "validation_error", message: "private provider diagnostics" }),
    });

    await assert.rejects(
      sendTestEmail({ to: "recipient@example.net" }),
      (error) => {
        assert.equal(error.code, "RESEND_HTTP_422");
        assert.match(error.message, /HTTP 422/);
        assert.doesNotMatch(error.message, /private provider diagnostics|re_test_secret_key/);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
    restoreEnvironment(savedEnv);
  }
});

test("production cannot fall back to console email delivery", () => {
  assert.throws(
    () => assertEmailProviderConfiguration({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }),
    /console email delivery is development-only/i,
  );
});

test("local development can print action links in console mode when no email API is configured", async () => {
  const savedEnv = saveEnvironment();
  const originalWarn = console.warn;
  let logged = "";
  try {
    setEnvironment({ NODE_ENV: "development", EMAIL_PROVIDER: "console", PUBLIC_APP_URL: "http://localhost:5173" });
    console.warn = (message) => { logged = String(message); };
    const result = await sendApprovalEmail({ to: "member@example.net", fullName: "Member", approved: false });
    assert.equal(result.mode, "console");
    assert.match(logged, /development-email-only/);
    assert.match(logged, /not approved/i);
  } finally {
    console.warn = originalWarn;
    restoreEnvironment(savedEnv);
  }
});

test("live email test rejects malformed recipient addresses", async () => {
  const savedEnv = saveEnvironment();
  try {
    setEnvironment(resendEnv);
    await assert.rejects(sendTestEmail({ to: "not-an-email" }), /valid recipient email address/i);
  } finally {
    restoreEnvironment(savedEnv);
  }
});
