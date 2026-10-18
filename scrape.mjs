import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const BASE = 'https://www.holland2stay.com/residences';
const FILTERS = 'city%5Bfilter%5D=The+Hague%2C90&available_to_book%5Bfilter%5D=Available+to+book%2C179';
const pageUrl = (n) => `${BASE}?page=${n}&${FILTERS}`;
const MAX_PAGES = 50;

// Watch mode re-runs every 8-12 minutes (random, so requests don't land on a fixed rhythm).
const MIN_INTERVAL_MS = 8 * 60_000;
const MAX_INTERVAL_MS = 12 * 60_000;
const SEEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seen-listings.json');

// The site sits behind a Cloudflare challenge, so a plain HTTP client is blocked.
// A real (headed) Chrome with a persistent profile passes it; the profile keeps the clearance cookie.
const profileDir = path.join(os.tmpdir(), 'h2s-profile');


async function waitForChallenge(page) {
  for (let i = 0; i < 30; i++) {
    if (!(await page.title()).includes('Just a moment')) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('Cloudflare challenge was not passed');
}

// Cards render client-side and the page first shows unfiltered cards before the filters apply,
// so wait until the card count has stopped changing.
async function waitForListingsToSettle(page) {
  const cards = page.locator('.residence_block');
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 5; i++) {
    await page.waitForTimeout(1000);
    const count = await cards.count();
    stable = count === last ? stable + 1 : 0;
    last = count;
  }
}

async function extractListings(page) {
  return page.$$eval('.residence_block', (cards) => {
    const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return cards.map((card) => {
      const link = card.querySelector('.residence_info a[href]');
      const features = [...card.querySelectorAll('.features li')].map(t);
      return {
        name: t(card.querySelector('.residence_name')),
        url: link ? new URL(link.getAttribute('href'), location.origin).href : null,
        label: t(card.querySelector('.offer_label')) || null,
        bookingType: t(card.querySelector('.booking_btn')) || null,
        price: t(card.querySelector('.price_text')),
        serviceCosts: t(card.querySelector('.serviceList_text')) || null,
        availableFrom: t(card.querySelector('.rightSide .date')) || null,
        features,
        images: [...new Set([...card.querySelectorAll('.residence_img img')].map((i) => i.src))],
      };
    });
  });
}

async function scrapeAll(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  const listings = [];
  const seen = new Set();

  for (let n = 1; n <= MAX_PAGES; n++) {
    await page.goto(pageUrl(n));
    await waitForChallenge(page);
    await waitForListingsToSettle(page);

    const found = (await extractListings(page)).filter((l) => l.url && !seen.has(l.url));
    if (found.length === 0) break;
    found.forEach((l) => seen.add(l.url));
    listings.push(...found);
  }
  return listings;
}

function loadStored() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Phone push via ntfy (https://ntfy.sh). Anyone who knows the topic can read and post to it.
// NTFY_TOPIC overrides the default; set it to an empty string to turn notifications off.
async function notify(listing) {
  const topic = process.env.NTFY_TOPIC ?? 'holland2stay-2026-nl';
  if (!topic) return;
  const body = [listing.name, listing.price, `Available ${listing.availableFrom}`, ...listing.features.slice(0, 4)].join('\n');
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'New Holland2Stay listing', Click: listing.url, Priority: 'high', Tags: 'house' },
      body,
    });
    if (!res.ok) console.error(`ntfy responded ${res.status}`);
  } catch (err) {
    console.error(`ntfy failed: ${err.message}`);
  }
}

// Logs only listings that aren't in the local store yet, then adds them to it.
async function reportNew(listings) {
  const stored = loadStored();
  const fresh = listings.filter((l) => !stored[l.url]);
  if (fresh.length === 0) return;

  const now = new Date().toISOString();
  for (const l of fresh) stored[l.url] = { ...l, firstSeen: now };
  fs.writeFileSync(SEEN_FILE, JSON.stringify(stored, null, 2));
  console.log(JSON.stringify(fresh, null, 2));
  for (const l of fresh) await notify(l);
}

const launch = () =>
  chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

const watch = process.argv.includes('--watch');
let context = await launch();

try {
  do {
    try {
      await reportNew(await scrapeAll(context));
    } catch (err) {
      // A failed run must not end the watch loop or touch the store.
      console.error(`[${new Date().toISOString()}] scrape failed: ${err.message}`);
      if (!context.browser()?.isConnected?.() && context.pages().length === 0) context = await launch();
    }
    if (!watch) break;
    const wait = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
    await new Promise((r) => setTimeout(r, wait));
  } while (true);
} finally {
  await context.close();
}
