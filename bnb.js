


const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const SITE_URL = "https://grok.com/imagine";
const SCRIPT_FOLDER = "./video_scripts";
const DOWNLOAD_FOLDER = path.resolve("./downloads");
const USER_DATA_DIR = path.resolve("./user_data");

let processedCount = 0;

const GENERATE_BUTTON_SELECTOR = 'svg[width="20"][height="20"]';
const DOWNLOAD_BUTTON_SELECTORS = [
  'button[aria-label="Télécharger"]',
  'button[aria-label="Download"]'
];

const CANCEL_KEYWORDS = [
  'Annuler la vidéo',
  'Cancel video',
  'Cancelar vídeo'
];

const GENERATION_PROGRESS_REGEX = /(\b\d{1,3})%/;

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
  const editorHandle = await page.waitForFunction(
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

  const element = editorHandle.asElement();

  if (!element) {
    throw new Error("Prompt editor found but it is not an element handle");
  }

  return element;
}

async function clearEditor(page, editorHandle) {
  await editorHandle.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await humanDelay(200, 500);
  await page.keyboard.press("Backspace");
}

async function clearEditorForNextScene(page, editorHandle) {
  await clearEditor(page, editorHandle);
  await humanDelay(200, 500);

  const isEmpty = await page.evaluate((editor) => {
    const text = (editor.innerText || editor.textContent || "").replace(/\u200B/g, "").trim();
    return text.length === 0;
  }, editorHandle);

  if (!isEmpty) {
    await clearEditor(page, editorHandle);
  }
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

function logSceneStage(sceneMeta, stage, details = "") {
  const prefix = `🧭 [${sceneMeta.file}] Scene ${sceneMeta.sceneNumber} Attempt ${sceneMeta.attempt}`;
  console.log(`${prefix} | ${stage}${details ? ` | ${details}` : ""}`);
}

async function runSceneStage(page, sceneMeta, stageName, action) {
  const startedAt = Date.now();
  logSceneStage(sceneMeta, `${stageName} - START`);

  try {
    const result = await action();
    const elapsed = Date.now() - startedAt;
    logSceneStage(sceneMeta, `${stageName} - OK`, `${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    logSceneStage(sceneMeta, `${stageName} - FAIL`, `${elapsed}ms | ${error.message}`);
    await captureErrorContext(page, `${sceneMeta.file}-scene-${sceneMeta.sceneNumber}-${stageName.replace(/\s+/g, "-").toLowerCase()}`);
    throw error;
  }
}


async function waitForGenerationCompletion(page, sceneMeta, timeout = 600000) {
  const start = Date.now();

  const generationStarted = await page.waitForFunction((keywords, progressPatternSource) => {
    const text = document.body.innerText || "";
    const progressPattern = new RegExp(progressPatternSource);
    const hasCancel = keywords.some(keyword => text.includes(keyword));
    const hasProgress = progressPattern.test(text);

    return hasCancel || hasProgress;
  }, { timeout: 60000 }, CANCEL_KEYWORDS, GENERATION_PROGRESS_REGEX.source).catch(() => null);

  if (!generationStarted) {
    logSceneStage(sceneMeta, "generation-start-signal", "not detected within 60s; falling back to completion checks");
  } else {
    logSceneStage(sceneMeta, "generation-start-signal", "detected");
  }

  await page.waitForFunction((keywords, progressPatternSource, downloadSelectors) => {
    const text = document.body.innerText || "";
    const progressPattern = new RegExp(progressPatternSource);

    const hasCancel = keywords.some(keyword => text.includes(keyword));
    const hasProgress = progressPattern.test(text);
    const hasDownloadButton = downloadSelectors.some(selector => !!document.querySelector(selector));

    if (hasDownloadButton) {
      return true;
    }

    return !hasCancel && !hasProgress;
  }, { timeout }, CANCEL_KEYWORDS, GENERATION_PROGRESS_REGEX.source, DOWNLOAD_BUTTON_SELECTORS);

  const elapsed = Date.now() - start;
  logSceneStage(sceneMeta, "generation-finish-signal", `${elapsed}ms`);
}

async function waitForGenerationWithHumanLoading(page, sceneMeta, timeout = 600000) {
  const loadingPhrases = [
    "🧠 Preparing cinematic details...",
    "🎞️ Fine-tuning motion and lighting...",
    "🎬 Almost there, rendering naturally...",
    "✨ Adding final visual polish..."
  ];

  const generationPromise = waitForGenerationCompletion(page, sceneMeta, timeout);

  const loadingPromise = (async () => {
    let step = 0;

    while (true) {
      const done = await Promise.race([
        generationPromise.then(() => true).catch(() => true),
        delay(random(2500, 4500)).then(() => false)
      ]);

      if (done) break;

      console.log(loadingPhrases[step % loadingPhrases.length]);
      step++;

      if (Math.random() > 0.45) {
        await humanMouseMove(page);
      }

      if (Math.random() > 0.65) {
        await humanScroll(page);
      }
    }
  })();

  await Promise.all([generationPromise, loadingPromise]);
}

async function clickFirstAvailable(page, selectors, timeout = 120000) {
  for (const selector of selectors) {
    const button = await page.$(selector);
    if (button) {
      await button.click();
      return selector;
    }
  }

  await page.waitForFunction(
    (buttonSelectors) => buttonSelectors.some(selector => !!document.querySelector(selector)),
    { timeout },
    selectors
  );

  for (const selector of selectors) {
    const button = await page.$(selector);
    if (button) {
      await button.click();
      return selector;
    }
  }

  throw new Error(`No selector matched: ${selectors.join(", ")}`);
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

async function waitForNewDownload(folder, knownFiles = [], timeout = 180000) {
  const start = Date.now();
  const knownSet = new Set(knownFiles);

  while (Date.now() - start < timeout) {
    const files = fs.readdirSync(folder);
    const downloading = files.find(f => f.endsWith(".crdownload"));
    const newCompletedFile = files.find(
      f => !knownSet.has(f) && !f.endsWith(".crdownload")
    );

    if (newCompletedFile && !downloading) {
      return newCompletedFile;
    }

    await delay(2000);
  }

  return false;
}

function ensureRuntimeFolders() {
  const folders = [SCRIPT_FOLDER, DOWNLOAD_FOLDER, USER_DATA_DIR];

  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
      console.log(`📁 Created missing folder: ${folder}`);
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

async function processScene(page, scene, index, file, attempt) {
  const sceneMeta = {
    file,
    sceneNumber: index + 1,
    attempt
  };

  const fileBaseName = path.parse(file).name;
  const targetDownloadFolder = path.join(DOWNLOAD_FOLDER, fileBaseName);

  if (!fs.existsSync(targetDownloadFolder)) {
    fs.mkdirSync(targetDownloadFolder, { recursive: true });
  }

  try {
    await runSceneStage(page, sceneMeta, "auth-check", async () => {
      await ensureLoggedIn(page);
    });

    const editorHandle = await runSceneStage(page, sceneMeta, "find-editor", async () => {
      return findPromptEditor(page, 60000);
    });

    await runSceneStage(page, sceneMeta, "prepare-editor", async () => {
      await humanMouseMove(page);
      await humanDelay();

      await editorHandle.click({ clickCount: 1 });
      await humanDelay(300, 800);

      await clearEditorForNextScene(page, editorHandle);
      await humanDelay();
    });

    await runSceneStage(page, sceneMeta, "type-scene", async () => {
      await humanTypeInEditor(page, editorHandle, scene);
    });

    await runSceneStage(page, sceneMeta, "trigger-generation", async () => {
      await humanDelay(1500, 4000);
      await humanScroll(page);

      await humanMouseMove(page);
      await page.click(GENERATE_BUTTON_SELECTOR);
    });

    console.log("🎬 Generating...");

    await runSceneStage(page, sceneMeta, "wait-generation-finish", async () => {
      await waitForGenerationWithHumanLoading(page, sceneMeta, 600000);
    });

    const knownFiles = fs.readdirSync(targetDownloadFolder);

    await runSceneStage(page, sceneMeta, "download-video", async () => {
      const downloadClient = await page.target().createCDPSession();
      await downloadClient.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: targetDownloadFolder
      });

      await humanDelay(1000, 3000);
      await humanMouseMove(page);
      const clickedSelector = await clickFirstAvailable(page, DOWNLOAD_BUTTON_SELECTORS, 120000);
      logSceneStage(sceneMeta, "download-button-clicked", clickedSelector);
    });

    const downloadedFile = await runSceneStage(page, sceneMeta, "wait-download", async () => {
      return waitForNewDownload(targetDownloadFolder, knownFiles);
    });

    if (!downloadedFile) throw new Error("Download timeout");

    const sceneFileName = `scene-${String(index + 1).padStart(3, "0")}${path.extname(downloadedFile) || ".mp4"}`;
    const sourcePath = path.join(targetDownloadFolder, downloadedFile);
    const destinationPath = path.join(targetDownloadFolder, sceneFileName);

    if (sourcePath !== destinationPath) {
      fs.renameSync(sourcePath, destinationPath);
    }

    logSceneStage(sceneMeta, "download-saved", destinationPath);

    processedCount++;

    console.log(`✅ Scene ${index + 1} done | Total: ${processedCount}`);

    /* استراحة كل 10 مشاهد */
    if (processedCount % 10 === 0) {
      console.log("☕ Taking human break...");
      await delay(random(20000, 60000));
    }

    return true;

  } catch (err) {
    console.log(`❌ Scene error: ${err.message}`);
    return false;
  }
}

/* ============================= */
/*       تشغيل دائم             */
/* ============================= */

async function start() {
  ensureRuntimeFolders();

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
      await delay(5000);

      const files = fs.readdirSync(SCRIPT_FOLDER).filter(f => f.endsWith(".txt"));

      if (!files.length) {
        console.log("⚠ No .txt files found in video_scripts. Waiting before next scan...");
        await delay(10000);
        continue;
      }

      for (const file of files) {
        const content = fs.readFileSync(path.join(SCRIPT_FOLDER, file), "utf-8");
        const scenes = content.split("-------").map(s => s.trim()).filter(Boolean);

        console.log(`📂 Processing file: ${file}`);

        for (let i = 0; i < scenes.length; i++) {
          let attempts = 0;
          let success = false;

          while (!success && attempts < 3) {
            success = await processScene(page, scenes[i], i, file, attempts + 1);
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
