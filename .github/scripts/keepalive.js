'use strict';

const fs = require('fs/promises');
const puppeteer = require('puppeteer');

const STREAMLIT_URL = process.env.STREAMLIT_URL;
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY;

const PAGE_LOAD_GRACE_PERIOD_MS = 5000;
const WAKE_BUTTON_POLL_TIMEOUT_MS = 60_000;
const WAKE_BUTTON_POLL_INTERVAL_MS = 1000;
const WAKE_MAX_ATTEMPTS = 3;
const WAKE_RETRY_BACKOFF_BASE_MS = 2000;
const WAKE_READY_TIMEOUT_MS = 120_000;
const WAKE_UP_BUTTON_SELECTOR = '[data-testid="wakeup-button-viewer"]';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 720 });

    const response = await page.goto(STREAMLIT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    if (!response) {
      throw new Error('No response received from the Streamlit app');
    }

    const status = response.status();
    console.log(`Initial response: [${status}] ${response.statusText()}`);
    if (status >= 400) {
      throw new Error(`Unexpected response status: ${status}`);
    }

    console.log(`Waiting ${PAGE_LOAD_GRACE_PERIOD_MS}ms for the app to settle`);
    await sleep(PAGE_LOAD_GRACE_PERIOD_MS);

    const findAndClickWakeButton = async () => {
      const pollDeadline = Date.now() + WAKE_BUTTON_POLL_TIMEOUT_MS;
      let clicked = null;

      while (!clicked && Date.now() < pollDeadline) {
        const contexts = [
          { ctx: page, label: 'main page' },
          ...page.frames().map((frame) => ({
            ctx: frame,
            label: `frame ${frame.url() || '[no URL]'}`,
          })),
        ];

        for (const { ctx, label } of contexts) {
          const button = await ctx.$(WAKE_UP_BUTTON_SELECTOR);
          if (button) {
            console.log(`Wake-up button detected (${label}); attempting to click`);
            await button.evaluate((node) =>
              node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }),
            );
            const box = await button.boundingBox();
            const inViewport = await button.isIntersectingViewport();
            if (!box && !inViewport) {
              continue;
            }
            await sleep(250);
            await button.click({ delay: 150 });
            clicked = { label, ctx };
            break;
          }
        }

        if (!clicked) await sleep(WAKE_BUTTON_POLL_INTERVAL_MS);
      }

      return clicked;
    };

    let lastClickedLabel = null;
    let lastClickedContext = null;

    for (let attempt = 1; attempt <= WAKE_MAX_ATTEMPTS; attempt += 1) {
      const clicked = await findAndClickWakeButton();

      if (!clicked) {
        console.log(
          `Wake-up button not found after polling; assuming app is already awake (attempt ${attempt}/${WAKE_MAX_ATTEMPTS})`,
        );
        console.log(
          `Keepalive succeeded in ${Date.now() - startedAt}ms (already awake)`,
        );
        return;
      }

      lastClickedLabel = clicked.label;
      lastClickedContext = clicked.ctx;

      console.log(
        `Wake-up button clicked (${clicked.label}) [attempt ${attempt}/${WAKE_MAX_ATTEMPTS}]; waiting for app to become ready`,
      );

      try {
        await Promise.race([
          lastClickedContext
            .waitForFunction(
              (selector) => !document.querySelector(selector),
              { timeout: WAKE_READY_TIMEOUT_MS },
              WAKE_UP_BUTTON_SELECTOR,
            )
            .catch(() => null),
          page
            .waitForNavigation({ waitUntil: 'networkidle2', timeout: WAKE_READY_TIMEOUT_MS })
            .catch(() => null),
        ]);
        await sleep(2_000);
      } catch (readyError) {
        await fail(
          'Wake-up button clicked but app did not become ready in time',
          readyError,
        );
      }

      const buttonStillThere = await lastClickedContext
        .$((WAKE_UP_BUTTON_SELECTOR))
        .catch((err) => {
          if (
            err.message.includes('Execution context was destroyed') ||
            err.message.includes('Cannot find context')
          ) {
            return null;
          }
          throw err;
        });

      if (!buttonStillThere) {
        console.log('Wake-up button disappeared; app should be awake');
        break;
      }

      if (attempt < WAKE_MAX_ATTEMPTS) {
        const backoffMs = WAKE_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        console.log(
          `Wake-up button still present after attempt ${attempt}; retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      } else {
        await fail(
          'Wake-up button still present after all wake attempts; app may still be sleeping',
        );
      }
    }

    console.log(
      `Keepalive succeeded in ${Date.now() - startedAt}ms${
        lastClickedLabel ? ` (wake-up button clicked on ${lastClickedLabel})` : ''
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
