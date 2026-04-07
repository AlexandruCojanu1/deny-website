import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

// Track all failed image/video requests
const failed = [];
const loaded = [];

page.on('response', (res) => {
  const url = res.url();
  const status = res.status();
  if (url.match(/\.(webp|jpg|jpeg|png|mp4|mp3|mov)(\?|$)/i)) {
    if (status >= 400) {
      failed.push({ url, status });
    } else {
      loaded.push({ url, status });
    }
  }
});

page.on('requestfailed', (req) => {
  const url = req.url();
  if (url.match(/\.(webp|jpg|jpeg|png|mp4|mp3|mov)(\?|$)/i)) {
    failed.push({ url, reason: req.failure()?.errorText || 'unknown' });
  }
});

await page.goto('http://localhost:3333/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));

// Scroll through the entire page to trigger lazy loading
const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
const viewportHeight = await page.evaluate(() => window.innerHeight);

for (let y = 0; y < scrollHeight; y += viewportHeight / 2) {
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
  await new Promise(r => setTimeout(r, 500));
}

// Wait for lazy images to load
await new Promise(r => setTimeout(r, 2000));

// Check all img elements for broken images
const brokenImgs = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  return imgs.map(img => ({
    src: img.src,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    complete: img.complete,
    broken: img.complete && img.naturalWidth === 0
  })).filter(i => i.broken || !i.complete);
});

// Check video elements
const videoStatus = await page.evaluate(() => {
  const vids = Array.from(document.querySelectorAll('video'));
  return vids.map(v => ({
    src: v.querySelector('source')?.src || v.src,
    readyState: v.readyState,
    error: v.error?.message || null
  }));
});

console.log('\n=== LOADED ASSETS ===');
console.log(`Images/media loaded OK: ${loaded.length}`);

console.log('\n=== FAILED NETWORK REQUESTS ===');
if (failed.length === 0) console.log('None!');
else failed.forEach(f => console.log(`  FAIL: ${f.url} (${f.status || f.reason})`));

console.log('\n=== BROKEN IMG ELEMENTS ===');
if (brokenImgs.length === 0) console.log('None!');
else brokenImgs.forEach(b => console.log(`  BROKEN: ${b.src} (natural: ${b.naturalWidth}x${b.naturalHeight}, complete: ${b.complete})`));

console.log('\n=== VIDEO STATUS ===');
videoStatus.forEach(v => console.log(`  ${v.src} - readyState: ${v.readyState}, error: ${v.error || 'none'}`));

// Take a screenshot
await page.screenshot({ path: 'puppeteer-check.png', fullPage: true });
console.log('\nFull-page screenshot saved to puppeteer-check.png');

await browser.close();
