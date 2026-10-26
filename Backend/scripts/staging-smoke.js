"use strict";

const frontendRaw = String(process.env.STAGING_FRONTEND_URL || "").trim();
const apiRaw = String(process.env.STAGING_API_URL || "").trim();
const allowInsecure = String(process.env.ALLOW_INSECURE_STAGING || "").toLowerCase() === "true";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function parseUrl(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
  if (!allowInsecure && url.protocol !== 'https:') throw new Error(`${label} must use HTTPS. For local-only staging tests, set ALLOW_INSECURE_STAGING=true explicitly.`);
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials.`);
  return url;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  return response;
}

async function check(label, callback) {
  try {
    const detail = await callback();
    console.log(`PASS: ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    fail(`${label} — ${error.message}`);
  }
}

async function main() {
  let frontendUrl;
  let apiUrl;
  try {
    frontendUrl = parseUrl(frontendRaw, 'STAGING_FRONTEND_URL');
    apiUrl = parseUrl(apiRaw, 'STAGING_API_URL');
  } catch (error) {
    console.error(`Staging smoke test configuration error: ${error.message}`);
    console.error('Example: STAGING_FRONTEND_URL=https://staging.example.rw STAGING_API_URL=https://api-staging.example.rw/api npm run smoke:staging');
    process.exit(2);
  }
  const apiBase = apiUrl.toString().replace(/\/$/, '');

  await check('Frontend responds successfully', async () => {
    const response = await request(frontendUrl.toString());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) throw new Error(`unexpected content-type ${type || '(missing)'}`);
    return `HTTP ${response.status}`;
  });

  await check('API health endpoint responds', async () => {
    const response = await request(`${apiBase}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== 'ok') throw new Error(`unexpected status ${body.status || '(missing)'}`);
    return `HTTP ${response.status}`;
  });

  await check('API database readiness responds', async () => {
    const response = await request(`${apiBase}/health/ready`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== 'ready') throw new Error(`unexpected status ${body.status || '(missing)'}`);
    return `HTTP ${response.status}`;
  });

  await check('Credentialed CORS allows the frontend origin and financial idempotency header', async () => {
    const response = await request(`${apiBase}/auth/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: frontendUrl.origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type,idempotency-key',
      },
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`preflight HTTP ${response.status}`);
    if (response.headers.get('access-control-allow-origin') !== frontendUrl.origin) throw new Error('Access-Control-Allow-Origin does not exactly match the deployed frontend origin.');
    if (String(response.headers.get('access-control-allow-credentials')).toLowerCase() !== 'true') throw new Error('Access-Control-Allow-Credentials is not true.');
    const allowed = String(response.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map((part) => part.trim());
    for (const header of ['content-type', 'idempotency-key']) if (!allowed.includes(header)) throw new Error(`CORS does not permit ${header}.`);
    return 'origin, credentials and idempotency header are accepted';
  });

  if (process.exitCode) {
    console.error('\nStaging smoke test failed. Fix failed checks before inviting members.');
    process.exit(1);
  }
  console.log('\nStaging smoke checks passed. This does not test member login, financial workflows, transactional-email API delivery, HTTPS cookie flags, private database networking, or backup restoration; complete the accompanying checklist.');
}

main().catch((error) => {
  fail(error.message || 'Unexpected staging smoke-test error.');
  process.exit(1);
});
