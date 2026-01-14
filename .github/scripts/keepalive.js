'use strict';

const fs = require('fs/promises');
const puppeteer = require('puppeteer');

const STREAMLIT_URL = process.env.STREAMLIT_URL;
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY;

const PAGE_LOAD_GRACE_PERIOD_MS = 8000;
const WAKE_UP_BUTTON_SELECTOR = '[data-testid="wakeup-button-viewer"]';

const buildFailureSummary = (lines) =>
  [
    '### Streamlit keepalive failed',
    '',
    ...lines.map((line) => `- ${line}`),
    '',
  ].join('\n');

const appendFailureSummary = async (lines) => {
  if (!SUMMARY_PATH) {
    console.warn('GITHUB_STEP_SUMMARY is not set; skipping summary output.');
    return;
  }

  try {
    await fs.appendFile(SUMMARY_PATH, buildFailureSummary(lines));
  } catch (writeError) {
    console.error('Failed to write failure summary:', writeError);
  }
};

const fail = async (reason, err) => {
  console.error(reason);
  if (err) console.error(err);

  await appendFailureSummary([
    `URL: ${STREAMLIT_URL || 'not set'}`,
    `Reason: ${reason}`,
    ...(err ? [`Error: ${err.message || err}`] : []),
  ]);

  process.exit(1);
};

(async () => {
  if (!STREAMLIT_URL) {
    await fail('STREAMLIT_URL env var is required');
  }

  console.log(`Starting keepalive for ${STREAMLIT_URL}`);

  let browser;
  const startedAt = Date.now();

  try {
    browser = await puppeteer.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: ['--no-sandbox'],
    });

    const page = await browser.newPage();
    const response = await page.goto(STREAMLIT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    if (!response) {
      throw new Error('No response received from the Streamlit app');
    }

    const status = response.status();
    console.log(`Initial response: ${status} ${response.statusText()}`);
    if (status >= 400) {
      throw new Error(`Unexpected response status: ${status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, PAGE_LOAD_GRACE_PERIOD_MS));

    const checkForWakeButton = async (context) => {
      const button = await context.$(WAKE_UP_BUTTON_SELECTOR);
      if (button) {
        console.log('Wake-up button detected; attempting to click');
        await button.click();
        return true;
      }

      return false;
    };

    let clicked = await checkForWakeButton(page);
    if (!clicked) {
      for (const frame of page.frames()) {
        clicked = await checkForWakeButton(frame);
        if (clicked) break;
      }
    }

    console.log(
      `Keepalive succeeded in ${Date.now() - startedAt}ms${
        clicked ? ' (wake-up button clicked)' : ''
      }`,
    );
  } catch (error) {
    await fail('Failed to keep Streamlit app awake', error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Failed to close browser', closeError);
      }
    }
  }
})();
