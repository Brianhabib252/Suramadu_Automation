/**
 * Utility script that logs into Suramadu, re-extracts a target article, and
 * prints the AI rejection reasons to help operators understand policy failures.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { extractNews } from '../src/lib/newsExtract';
import { aiEvaluate } from '../src/lib/policyLLM';

// Minimal login routine shared by the script and kept here for clarity.
async function ensureLoggedIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('https://suramadu.pta-surabaya.go.id/auth/masuk', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('form#form-login', { state: 'visible' });
  await page.fill('form#form-login input[name="nip"]', username);
  await page.fill('form#form-login input[name="pass"]', password);
  await page.click('form#form-login button[type="submit"]');
  await page.waitForLoadState('load');
}

// Launch a headless session, run extraction + AI evaluation, and print results.
async function main(): Promise<void> {
  const username = process.env.SURAMADU_USERNAME;
  const password = process.env.SURAMADU_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing SURAMADU_USERNAME or SURAMADU_PASSWORD environment variables.');
  }

  const targetUrl =
    process.argv[2] ??
    'https://suramadu.pta-surabaya.go.id/superuser/pengadilan_berita/konfirmasi/15440/pa-lumajang-mantapkan-pengelolaan-aset-dan-persediaan-jelang-penutupan-tahun-anggaran-2025';

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await ensureLoggedIn(page, username, password);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('xpath=//*[@id="form-blog"]/div[5]/div/div/div[2]', {
      timeout: 120_000,
    });

    const extraction = await extractNews(page);
    const aiResult = await aiEvaluate({ extraction });

    console.log('AI Source:', aiResult.source);
    console.log('AI Confidence:', aiResult.confidence.toFixed(2));
    console.log('AI Violations:', aiResult.violations.join(', ') || '(none)');
    console.log('AI Rejection Message:\n', aiResult.rejection_message ?? '(none)');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error('Failed to retrieve AI rejection reason:', error);
  process.exit(1);
});
