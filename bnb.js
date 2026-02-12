


const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const SITE_URL = "https://grok.com/imagine";
const SCRIPT_FOLDER = "./video_scripts";
const DOWNLOAD_FOLDER = path.resolve("./downloads");
const USER_DATA_DIR = path.resolve("./user_data");
const COOKIES_FILE = "./cookies.json";

let processedCount = 0;

const PROMPT_SELECTORS = [
  'div.tiptap.ProseMirror[contenteditable="true"]',
  'p[data-placeholder="Type to imagine"]',
  'p[data-placeholder="Tapez pour imaginer"]'
];

/* ============================= */
/*        أدوات بشرية            */
/* ============================= */

function random(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function humanDelay(min = 500, max = 1500) {
  await delay(random(min, max));
}

async function humanMouseMove(page) {
  await page.mouse.move(random(100, 1000), random(100, 700), {
    steps: random(15, 40)
  });
}

async function humanScroll(page) {
  await page.evaluate(() => {
    window.scrollBy(0, Math.floor(Math.random() * 400));
  });
}

async function humanType(page, selector, text) {
  for (let char of text) {
    await page.type(selector, char);
    await delay(random(40, 120));
  }
}

async function humanTypeInEditor(page, editorHandle, text) {
  await editorHandle.focus();

  for (let char of text) {
    await page.keyboard.type(char);
    await delay(random(40, 120));
  }
}

async function findPromptEditor(page, timeout = 60000) {
  return page.waitForFunction(
    selectors => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);

        if (!el) continue;

        const contentEditable = el.closest('[contenteditable="true"]') ||
          (el.getAttribute && el.getAttribute("contenteditable") === "true" ? el : null);

        if (contentEditable) {
          return contentEditable;
        }
      }

      return null;
    },
    { timeout },
    PROMPT_SELECTORS
  );
}

async function clearEditor(page, editorHandle) {
  await editorHandle.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await humanDelay(200, 500);
  await page.keyboard.press("Backspace");
}

async function captureErrorContext(page, label) {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const debugDir = path.resolve("./debug");

  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const screenshotPath = path.join(debugDir, `${label}-${stamp}.png`);
  const htmlPath = path.join(debugDir, `${label}-${stamp}.html`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf-8");
    console.log(`🧪 Error context saved: ${screenshotPath} | ${htmlPath}`);
  } catch (captureErr) {
    console.log(`⚠ Failed to capture error context: ${captureErr.message}`);
  }
}

/* ============================= */
/*     تحميل حقيقي              */
/* ============================= */

async function waitForDownload(folder, timeout = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = fs.readdirSync(folder);
    const downloading = files.find(f => f.endsWith(".crdownload"));
    if (!downloading && files.length > 0) return true;
    await delay(2000);
  }
  return false;
}

/* ============================= */
/*     حقن كوكيز                */
/* ============================= */

async function injectCookies(page) {
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE));
      await page.setCookie(...cookies);
      await page.reload({ waitUntil: "networkidle2" });
      console.log("✅ Cookies injected");
      await delay(5000);
    } catch (e) {
      console.log("⚠ Cookie injection failed");
    }
  }
}

/* ============================= */
/*     فحص تسجيل الدخول         */
/* ============================= */

async function ensureLoggedIn(page) {
  const isLoginPage = await page.evaluate(() => {
    return document.body.innerText.includes("Login") ||
           document.body.innerText.includes("Sign in");
  });

  if (isLoginPage) {
    console.log("❌ Session expired. Waiting for manual login...");
    await page.waitForNavigation({ waitUntil: "networkidle2" });
  }
}

/* ============================= */
/*     توليد مشهد               */
/* ============================= */

async function processScene(page, scene, index) {
  try {
    await ensureLoggedIn(page);

    const editorHandle = await findPromptEditor(page, 60000);

    await humanMouseMove(page);
    await humanDelay();

    await editorHandle.click({ clickCount: 1 });
    await humanDelay(300, 800);

    await clearEditor(page, editorHandle);
    await humanDelay();

    await humanTypeInEditor(page, editorHandle, scene);

    await humanDelay(1500, 4000);
    await humanScroll(page);

    await humanMouseMove(page);
    await page.click('svg[width="20"][height="20"]');

    console.log("🎬 Generating...");

    await page.waitForFunction(() => {
      return !document.body.innerText.includes("Annuler la vidéo");
    }, { timeout: 600000 });

    await humanDelay(1000, 3000);

    await page.waitForSelector('button[aria-label="Télécharger"]', { timeout: 120000 });

    await humanMouseMove(page);
    await page.click('button[aria-label="Télécharger"]');

    const downloaded = await waitForDownload(DOWNLOAD_FOLDER);

    if (!downloaded) throw new Error("Download timeout");

    processedCount++;

    console.log(`✅ Scene ${index + 1} done | Total: ${processedCount}`);

    /* استراحة كل 10 مشاهد */
    if (processedCount % 10 === 0) {
      console.log("☕ Taking human break...");
      await delay(random(20000, 60000));
    }

    return true;

  } catch (err) {
    await captureErrorContext(page, `scene-${index + 1}`);
    console.log(`❌ Scene error: ${err.message}`);
    return false;
  }
}

/* ============================= */
/*       تشغيل دائم             */
/* ============================= */

async function start() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--mute-audio"
    ]
  });

  const pages = await browser.pages();
  const existingImaginePage = pages.find(p => p.url().startsWith(SITE_URL));
  const page = existingImaginePage || pages.find(p => p.url() !== "about:blank") || pages[0] || await browser.newPage();

  for (const openedPage of pages) {
    if (openedPage !== page) {
      await openedPage.close();
    }
  }

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_FOLDER
  });

  while (true) {
    try {
      await page.goto(SITE_URL, { waitUntil: "networkidle2" });

      await injectCookies(page);
      await delay(5000);

      const files = fs.readdirSync(SCRIPT_FOLDER).filter(f => f.endsWith(".txt"));

      for (const file of files) {
        const content = fs.readFileSync(path.join(SCRIPT_FOLDER, file), "utf-8");
        const scenes = content.split("-------").map(s => s.trim()).filter(Boolean);

        console.log(`📂 Processing file: ${file}`);

        for (let i = 0; i < scenes.length; i++) {
          let attempts = 0;
          let success = false;

          while (!success && attempts < 3) {
            success = await processScene(page, scenes[i], i);
            attempts++;

            if (!success) {
              console.log("🔁 Retrying scene...");
              await delay(5000);
            }
          }
        }
      }

      console.log("🔁 Restarting cycle...");
      await delay(15000);

    } catch (err) {
      console.log("🔥 Critical crash — restarting browser...");
      await browser.close();
      return start();
    }
  }
}

start();
