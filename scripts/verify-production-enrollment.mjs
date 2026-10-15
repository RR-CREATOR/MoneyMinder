import path from "node:path";
import { fileURLToPath } from "node:url";

function exactOrigin(value, name, { httpsOnly = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)
      || (httpsOnly && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.origin !== String(value).replace(/\/$/, "")) {
    throw new Error(`${name} must be an ${httpsOnly ? "HTTPS" : "HTTP(S)"} origin`);
  }
  return parsed.origin;
}

function assertClosedLogin(html) {
  const block = html.match(/<p\b[^>]*\bid=["']registration-cta["'][^>]*>[\s\S]*?<\/p>/i);
  if (!block) throw new Error("Login page registration CTA is missing");
  if (!/(?:^|\s)hidden(?:\s|=|>)/i.test(block[0].match(/^<p\b[^>]*>/i)?.[0] || "")) {
    throw new Error("Closed registration CTA must be hidden");
  }
  if (!/invited pilot participants/i.test(html)) {
    throw new Error("Login page must disclose invited pilot access");
  }
  if (!/href=["']register\.html["']/i.test(block[0])) {
    throw new Error("Registration CTA must link to register.html");
  }
  if (/href=["']register\.html["']/i.test(html.replace(block[0], ""))) {
    throw new Error("Login page contains another visible registration link");
  }
}

export async function verifyClosedEnrollment({
  baseUrl,
  appOrigin,
  fetchImpl = fetch,
}) {
  const base = exactOrigin(baseUrl, "baseUrl");
  const publicOrigin = exactOrigin(appOrigin, "appOrigin", { httpsOnly: true });
  const request = (pathname, options = {}) => fetchImpl(new URL(pathname, `${base}/`), {
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    ...options,
  });

  const loginResponse = await request("/login.html");
  if (loginResponse.status !== 200) {
    throw new Error(`Login page returned HTTP ${loginResponse.status}`);
  }
  assertClosedLogin(await loginResponse.text());

  const registrationPage = await request("/register.html");
  if (registrationPage.status !== 404) {
    throw new Error(`Closed registration page returned HTTP ${registrationPage.status}, expected 404`);
  }

  const apiRegistration = await request("/api/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
    },
    body: "{}",
  });
  if (apiRegistration.status !== 403) {
    throw new Error(`Closed registration API returned HTTP ${apiRegistration.status}, expected 403`);
  }

  return {
    apiRegistrationStatus: apiRegistration.status,
    loginStatus: loginResponse.status,
    registrationPageStatus: registrationPage.status,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyClosedEnrollment({
    baseUrl: process.argv[2],
    appOrigin: process.argv[3] || process.env.APP_ORIGIN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
