const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { chromium } = require("@playwright/test");
const { REPO_ROOT, getEnvWithDotEnv } = require("./_deploy_env");

const env = getEnvWithDotEnv();
const args = process.argv.slice(2);
const promptForVisualCheck = args.includes("--prompt") && !process.env.CI;
const targetUrl =
  args.find((arg) => !arg.startsWith("--")) ||
  process.env.EWS_SMOKE_URL ||
  env.EWS_PUBLIC_URL ||
  "https://ews.example.com/";
const outputDir = process.env.EWS_SMOKE_OUTPUT_DIR || path.join(REPO_ROOT, "tmp", "smoke");

function isDashboardResponse(response) {
  try {
    const url = new URL(response.url());
    return /\/(?:dashboard|military-dashboard|untracked-dashboard)\.json$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function captureViewport(page, viewport, fileName) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  const screenshotPath = path.join(outputDir, fileName);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const dashboardResponses = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  page.on("response", (response) => {
    if (!isDashboardResponse(response)) {
      return;
    }

    dashboardResponses.push({
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
    });
  });

  const primaryDashboardResponsePromise = page
    .waitForResponse((response) => {
      if (!isDashboardResponse(response)) {
        return false;
      }
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith("/dashboard.json");
    }, { timeout: 45_000 })
    .catch(() => null);

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: /Apocalypse Early Warning System/i }).waitFor({ timeout: 30_000 });
  const primaryDashboardResponse = await primaryDashboardResponsePromise;

  if (!primaryDashboardResponse) {
    failures.push("No primary dashboard JSON response was observed.");
  }

  await page.waitForTimeout(2_500);

  for (const response of dashboardResponses) {
    if (response.status < 200 || response.status >= 300) {
      failures.push(`Dashboard request failed: ${response.status} ${response.url}`);
    }
    if (!/\bapplication\/json\b/i.test(response.contentType)) {
      failures.push(`Dashboard response was not JSON: ${response.contentType || "no content-type"} ${response.url}`);
    }
  }

  const dashboardUnavailableCount = await page.getByText("Dashboard Data Unavailable").count();
  if (dashboardUnavailableCount > 0) {
    failures.push("The live page rendered the dashboard data unavailable fallback.");
  }

  const wholePageUnavailableCount = await page
    .locator("main h1", { hasText: /^Data Unavailable$/ })
    .count();
  if (wholePageUnavailableCount > 0) {
    failures.push("The live page rendered the old whole-page Data Unavailable state.");
  }

  const desktopScreenshot = await captureViewport(page, { width: 1440, height: 1100 }, "live-desktop.png");
  const mobileScreenshot = await captureViewport(page, { width: 390, height: 844 }, "live-mobile.png");

  if (pageErrors.length) {
    failures.push(`Browser page errors:\n${pageErrors.join("\n\n")}`);
  }

  console.log(`Smoke target: ${targetUrl}`);
  console.log(`Desktop screenshot: ${desktopScreenshot}`);
  console.log(`Mobile screenshot: ${mobileScreenshot}`);
  if (consoleErrors.length) {
    console.log("Browser console errors:");
    for (const error of consoleErrors) {
      console.log(`- ${error}`);
    }
  }

  if (promptForVisualCheck) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question("Inspect the screenshots. Press Enter to accept, or type fail: ");
    rl.close();
    if (/^f(?:ail)?$/i.test(answer.trim())) {
      failures.push("Visual inspection was marked as failed.");
    }
  }

  await browser.close();

  if (failures.length) {
    console.error("Live site smoke test failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("Live site smoke test passed.");
}

main().catch((error) => {
  console.error("Live site smoke test crashed:", error);
  process.exit(1);
});
