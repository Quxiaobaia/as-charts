/**
 * Real-GPU pipeline smoke runner.
 *
 * The unit suite runs against a recording mock, which is what makes the
 * structural gates cheap and deterministic — but a mock cannot tell you that the
 * composed GLSL compiles, that the VAO captured the instance attributes, or that
 * the projection put pixels where the caller asked. This runner boots the dev
 * server, drives `tests/e2e/pipeline.html` in headless Chrome (SwiftShader when
 * no GPU is available) and fails if the page's self-reported checks fail.
 *
 * It is deliberately *not* part of `npm run check`: it needs a browser, and a
 * browser is a moving part. `check` must never depend on one.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { createServer } from 'vite';

const PORT = 5179;
const PAGE = 'tests/e2e/pipeline.html';
const TIMEOUT_MS = 60_000;

/** First existing candidate wins; `CHROME_PATH` overrides everything. */
function findBrowser() {
  const candidates = [
    process.env['CHROME_PATH'],
    process.env['CHROMIUM_PATH'],
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

/**
 * Run the page and return its serialised result.
 *
 * `--dump-dom` prints the DOM after `load`, and the page's script is a module —
 * deferred, therefore already executed. That is why the page must stay
 * synchronous: an animation loop driven by `requestAnimationFrame` combined with
 * `--virtual-time-budget` advances virtual time without bound and kills the
 * renderer.
 */
function runBrowser(browser, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Ask for SwiftShader explicitly: CI machines have no GPU, and a hidden
        // fallback would make "it passed locally" meaningless.
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--hide-scrollbars',
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`browser did not finish within ${String(TIMEOUT_MS)} ms`));
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function extract(dom) {
  const status = /<body[^>]*data-status="([a-z]+)"/.exec(dom)?.[1];
  const payload = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
  return { status, payload };
}

const browser = findBrowser();
if (browser === undefined) {
  console.error('e2e: no Chrome/Chromium/Edge found. Set CHROME_PATH to run this suite.');
  process.exit(1);
}

const server = await createServer({
  // A dedicated port, and `strictPort: false` on purpose: this must be runnable
  // while the playground is already on 5178. The real URL is read back from the
  // server rather than assumed, so a fallback port cannot silently point the
  // browser at somebody else's app.
  server: { port: PORT, open: false, strictPort: false },
  logLevel: 'warn',
});

let exitCode = 0;
try {
  await server.listen();
  const origin = server.resolvedUrls?.local?.[0];
  if (origin === undefined) throw new Error('the dev server reported no local address');
  const url = new URL(PAGE, origin).href;
  console.log(`e2e: ${url}`);
  console.log(`e2e: browser ${browser}`);

  const { stdout, stderr } = await runBrowser(browser, url);
  const { status, payload } = extract(stdout);

  if (status === undefined || payload === undefined) {
    console.error('e2e: the page produced no result. Browser stderr follows:');
    console.error(stderr.trim());
    exitCode = 1;
  } else {
    console.log(`e2e: reported ${status.toUpperCase()}`);
    try {
      const report = JSON.parse(payload);
      for (const [key, value] of Object.entries(report.checks ?? {})) {
        console.log(`  ${key}: ${String(value)}`);
      }
    } catch {
      console.log(`  ${payload}`);
    }
    if (status !== 'ok') exitCode = 1;
  }
} catch (error) {
  console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);
