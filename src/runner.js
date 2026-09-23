const fs = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");
const { parseMacroText, decodeImacrosText } = require("./parser");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeCssAttributeValue(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function expandEnvPlaceholders(value = "") {
  return String(value).replace(/\$\{([A-Z0-9_]+)\}|\{\{([A-Z0-9_]+)\}\}/gi, (_, a, b) => {
    const key = a || b;
    return process.env[key] ?? "";
  });
}

function resolveMacroContent(value = "") {
  return decodeImacrosText(expandEnvPlaceholders(value));
}

async function resolveFilePath(value = "", baseDir = process.cwd()) {
  const raw = resolveMacroContent(value);
  if (!raw) return raw;

  if (path.isAbsolute(raw)) {
    return raw;
  }

  const normalizedRaw = raw.replace(/\\/g, path.sep);
  const workspaceRelative = path.resolve(baseDir, normalizedRaw);
  const imgRelative = path.resolve(baseDir, "img", normalizedRaw);

  try {
    await fs.access(workspaceRelative);
    return workspaceRelative;
  } catch {
    // fall through
  }

  try {
    await fs.access(imgRelative);
    return imgRelative;
  } catch {
    // fall through
  }

  return workspaceRelative;
}

function normalizeType(elementType = "") {
  return String(elementType).toLowerCase().replace(/^input:/, "input-");
}

function textMatches(actual, expected) {
  const text = String(actual || "").replace(/\s+/g, " ").trim();
  const needle = String(expected || "").replace(/\s+/g, " ").trim();

  if (!needle) return false;
  if (needle.endsWith("*")) {
    return text.toLowerCase().startsWith(needle.slice(0, -1).toLowerCase());
  }
  return text.toLowerCase() === needle.toLowerCase();
}

function buildTextPredicate(expected) {
  const needle = String(expected || "").replace(/\s+/g, " ").trim();
  const wildcard = needle.endsWith("*");
  const normalized = wildcard ? needle.slice(0, -1).toLowerCase() : needle.toLowerCase();

  return (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return false;
    return wildcard ? text.includes(normalized) : text === normalized;
  };
}

async function findHandleInFrame(frame, selector) {
  try {
    return await frame.$(selector);
  } catch {
    return null;
  }
}

async function findDeepHandleInFrame(frame, selector, pos = 1) {
  try {
    const handle = await frame.evaluateHandle((sel, nth) => {
      const results = [];

      const visit = (root) => {
        if (!root || !root.querySelectorAll) return;

        results.push(...Array.from(root.querySelectorAll(sel)));

        for (const node of root.querySelectorAll("*")) {
          if (node.shadowRoot) {
            visit(node.shadowRoot);
          }
        }
      };

      visit(document);
      return results[nth - 1] || null;
    }, selector, pos);

    return handle.asElement();
  } catch {
    return null;
  }
}

async function findAllHandles(page, selector) {
  const handles = [];

  for (const frame of page.frames()) {
    try {
      const frameHandles = await frame.$$(selector);
      handles.push(...frameHandles);
    } catch {
      // Ignore frames that are not ready or do not support the selector query.
    }
  }

  return handles;
}

async function findByText(page, selector, text, pos = 1) {
  const expected = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wildcard = String(text || "").trim().endsWith("*");

  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle((sel, needle, isWildcard, nth) => {
        const results = [];

        const visit = (root) => {
          if (!root || !root.querySelectorAll) return;

          for (const node of root.querySelectorAll(sel)) {
            const value = String(node.innerText || node.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();

            if (!needle) continue;
            if (isWildcard ? value.includes(needle) : value === needle) {
              results.push(node);
            }
          }

          for (const node of root.querySelectorAll("*")) {
            if (node.shadowRoot) {
              visit(node.shadowRoot);
            }
          }
        };

        visit(document);
        return results[nth - 1] || null;
      }, selector, wildcard ? expected.slice(0, -1) : expected, wildcard, pos);

      const element = handle.asElement();
      if (element) return element;
    } catch {
      // Ignore frames that do not support deep search.
    }
  }

  return null;
}

function normalizeComparableText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function attrKeyForMacroKey(key) {
  return String(key || "").toLowerCase();
}

async function findByTagAndAttrs(page, tagName, attrs, pos = 1) {
  const normalizedTag = String(tagName || "").toLowerCase();
  const normalizedAttrs = Object.fromEntries(
    Object.entries(attrs || {}).map(([key, value]) => [attrKeyForMacroKey(key), value])
  );

  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle((tag, queryAttrs, nth) => {
        const matches = [];
        const wildcard = Object.prototype.hasOwnProperty.call(queryAttrs, "*");
        const expectedText = String(queryAttrs.txt || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const wildcardText = expectedText.endsWith("*");
        const textNeedle = wildcardText ? expectedText.slice(0, -1) : expectedText;

        const entries = Object.entries(queryAttrs).filter(([key]) => key !== "*" && key !== "txt");

        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

        const attrMatches = (node) => {
          if (wildcard) return true;

          for (const [key, expected] of entries) {
            const actual = node.getAttribute(key);
            if (actual === null || actual === undefined) return false;
            if (normalize(actual) !== normalize(expected)) return false;
          }

          return true;
        };

        const textMatches = (node) => {
          if (!expectedText) return true;

          const actual = normalize(node.innerText || node.textContent || "");
          return wildcardText ? actual.includes(textNeedle) : actual === textNeedle;
        };

        const visit = (root) => {
          if (!root || !root.querySelectorAll) return;

          for (const node of root.querySelectorAll(tag)) {
            if (attrMatches(node) && textMatches(node)) {
              matches.push(node);
            }
          }

          for (const node of root.querySelectorAll("*")) {
            if (node.shadowRoot) {
              visit(node.shadowRoot);
            }
          }
        };

        visit(document);
        return matches[nth - 1] || null;
      }, normalizedTag, normalizedAttrs, pos);

      const element = handle.asElement();
      if (element) return element;
    } catch {
      // Ignore frames that do not support the deep query.
    }
  }

  return null;
}

async function findNthBySelector(page, selector, pos = 1) {
  for (const frame of page.frames()) {
    const handle = await findDeepHandleInFrame(frame, selector, pos);
    if (handle) return handle;
  }

  return null;
}

async function findElement(page, step) {
  const { elementType, pos, attrs } = step;
  const type = normalizeType(elementType);

  if (attrs.ID) {
    const selector = `[id="${escapeCssAttributeValue(attrs.ID)}"]`;
    const handle = await findDeepHandleInFrame(page.mainFrame(), selector, 1)
      || await findNthBySelector(page, selector, 1);
    if (handle) return handle;
  }

  if (attrs.NAME) {
    const selector = `[name="${escapeCssAttributeValue(attrs.NAME)}"]`;
    const handle = await findDeepHandleInFrame(page.mainFrame(), selector, 1)
      || await findNthBySelector(page, selector, 1);
    if (handle) return handle;
  }

  const textValue = attrs.TXT ? decodeImacrosText(attrs.TXT) : null;
  if (textValue) {
    const candidates = [];
    if (type === "button") candidates.push("button");
    if (type === "span") candidates.push("span");
    if (type === "label") candidates.push("label");
    if (type === "div") candidates.push("div");
    if (type === "path") candidates.push("path");
    if (type === "rect") candidates.push("rect");
    if (!candidates.length) candidates.push("button", "span", "label", "div");

    for (const selector of candidates) {
      const handle = await findByText(page, selector, textValue, pos);
      if (handle) return handle;
    }
  }

  if (type === "rect" || type === "path") {
    const handle = await findByTagAndAttrs(page, type, attrs, pos);
    if (handle) return handle;
  }

  if (type === "button" || type === "span" || type === "label" || type === "div") {
    const hasSpecificAttrs = Object.keys(attrs || {}).some((key) => !["TXT", "*"].includes(String(key).toUpperCase()));
    if (hasSpecificAttrs) {
      const handle = await findByTagAndAttrs(page, type, attrs, pos);
      if (handle) return handle;
    }
  }

  if (type === "input-text") {
    const selector = 'input[type="text"], input:not([type])';
    return findNthBySelector(page, selector, pos);
  }

  if (type === "input-password") {
    const selector = 'input[type="password"]';
    return findNthBySelector(page, selector, pos);
  }

  if (type === "input-file") {
    const selector = 'input[type="file"]';
    return findNthBySelector(page, selector, pos);
  }

  if (type.startsWith("input")) {
    const selector = `input`;
    return findNthBySelector(page, selector, pos);
  }

  if (type) {
    return findNthBySelector(page, type, pos);
  }

  return null;
}

async function waitForElement(page, step, timeoutMs) {
  const started = Date.now();
  const pollMs = 300;

  while (Date.now() - started < timeoutMs) {
    const handle = await findElement(page, step);
    if (handle) {
      return handle;
    }
    await delay(pollMs);
  }

  return null;
}

async function typeInto(page, handle, value) {
  const content = resolveMacroContent(value);
  await handle.click({ clickCount: 3 }).catch(() => {});
  await handle.press("Backspace").catch(() => {});
  await handle.type(content, { delay: 20 });
}

async function setValue(page, handle, value) {
  const content = resolveMacroContent(value);
  await handle.evaluate((node, nextValue) => {
    const prototype = Object.getPrototypeOf(node);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const setter = descriptor && descriptor.set;
    if (setter) setter.call(node, nextValue);
    else node.value = nextValue;

    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, content);
}

async function uploadFile(page, handle, value, baseDir = process.cwd()) {
  const filePath = await resolveFilePath(value, baseDir);
  await handle.uploadFile(filePath);
}

function isFileInputStep(step) {
  if (!step || step.type !== "tag") return false;
  return normalizeType(step.elementType) === "input-file";
}

async function clickHandle(page, handle) {
  await handle.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "center" });
  });

  const box = await handle.boundingBox().catch(() => null);
  if (box) {
    try {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        delay: 25,
      });
      return;
    } catch {
      // Fall through to Puppeteer element click.
    }
  }

  try {
    await handle.click({ delay: 25 });
    return;
  } catch {
    // Fall back to DOM clicks for elements that Puppeteer considers non-interactable.
  }

  await handle.evaluate((node) => {
    if (typeof node.click === "function") {
      node.click();
      return;
    }

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    node.dispatchEvent(event);
  });
}

async function executeStep(page, step, context) {
  if (step.type === "noop") return;

  if (step.type === "wait") {
    const ms = Math.max(0, Number(step.seconds || 0) * 1000);
    console.log(context.inspectMode ? `[${context.stepLabel}] wait: ${step.seconds}s` : `wait: ${step.seconds}s`);
    await delay(ms);
    return;
  }

  if (step.type === "goto") {
    console.log(context.inspectMode ? `[${context.stepLabel}] goto: ${step.url}` : `goto: ${step.url}`);
    await page.goto(step.url, { waitUntil: "networkidle2" });
    return;
  }

  if (step.type !== "tag") {
    console.log(context.inspectMode ? `[${context.stepLabel}] skip: ${step.raw}` : `skip: ${step.raw}`);
    return;
  }

  const waitMs = context.inspectMode ? 25000 : 12000;
  const handle = await waitForElement(page, step, waitMs);
  if (!handle) {
    throw new Error(`Elemen tidak ditemukan untuk langkah: ${step.raw}`);
  }

  const elementTag = await handle.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  const content = step.content !== null && step.content !== undefined ? resolveMacroContent(step.content) : null;
  const inputType = await handle.evaluate((node) => node.type || "").catch(() => "");
  const isInput = elementTag === "input" || elementTag === "textarea" || elementTag === "select";

  if (content !== null && isInput) {
    console.log(context.inspectMode ? `[${context.stepLabel}] fill: ${step.raw}` : `fill: ${step.raw}`);
    if (inputType === "file") {
      await uploadFile(page, handle, step.content, context.baseDir);
    } else if (inputType === "password" || inputType === "text" || inputType === "") {
      await typeInto(page, handle, content);
    } else {
      await setValue(page, handle, content);
    }
    await delay(150);
    return;
  }

  console.log(context.inspectMode ? `[${context.stepLabel}] click: ${step.raw}` : `click: ${step.raw}`);

  if (context.nextStep && isFileInputStep(context.nextStep) && context.nextStep.content) {
    const filePath = await resolveFilePath(context.nextStep.content, context.baseDir);
    const fileChooserPromise = page.waitForFileChooser({ timeout: 10000 }).catch(() => null);
    await clickHandle(page, handle);
    const fileChooser = await fileChooserPromise;

    if (fileChooser) {
      await fileChooser.accept([filePath]);
      await delay(context.clickDelayMs);
      return { consumedNextStep: true };
    }

    const fallbackFileStep = {
      type: "tag",
      elementType: "INPUT:FILE",
      pos: 1,
      attrs: {},
      raw: context.nextStep.raw,
      content: context.nextStep.content,
    };
    const fallbackWaitMs = context.inspectMode ? 20000 : 15000;
    const fallbackHandle = await waitForElement(page, fallbackFileStep, fallbackWaitMs);

    if (fallbackHandle) {
      await uploadFile(page, fallbackHandle, context.nextStep.content, context.baseDir);
      await delay(context.clickDelayMs);
      return { consumedNextStep: true };
    }

    throw new Error(`File upload tidak muncul setelah langkah: ${step.raw}`);
  }

  if (/TXT:UPS\b/i.test(step.raw)) {
    await delay(4000);
  }

  await clickHandle(page, handle);
  await delay(context.clickDelayMs);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
}

async function runMacroFile(filePath, options = {}) {
  const {
    headless = true,
    slowMo = 0,
    clickDelayMs = 400,
    inspectMode = false,
    keepBrowserOpen = !headless,
    startUpsOnly = false,
    txOnly = false,
    upsDelayMs = 0,
    dumpStep = null,
    noSandbox = false,
    baseDir = path.dirname(filePath),
  } = options;

  const macroText = await fs.readFile(filePath, "utf8");
  const steps = parseMacroText(macroText);

  const disableSandbox = Boolean(
    noSandbox || (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0)
  );

  const browser = await puppeteer.launch({
    headless,
    slowMo,
    defaultViewport: null,
    args: disableSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  await page.bringToFront().catch(() => {});

  try {
    let upsModeStarted = !startUpsOnly;
    let skipUntilUps = false;
    let upsDelayApplied = false;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];

      if (txOnly && /ATTR=TXT:UPS\b/i.test(step.raw)) {
        console.log(contextLabel(index, steps.length, inspectMode, "tx-only: stop before UPS"));
        break;
      }

      if (startUpsOnly && !upsModeStarted) {
        if (skipUntilUps) {
          if (/ATTR=TXT:UPS\b/i.test(step.raw)) {
            upsModeStarted = true;
          } else {
            console.log(contextLabel(index, steps.length, inspectMode, `skip-up-to-ups: ${step.raw}`));
            continue;
          }
        } else if (/ATTR=TXT:MASUK\b/i.test(step.raw)) {
          skipUntilUps = true;
        }
      }

      if (!startUpsOnly && !upsDelayApplied && upsDelayMs > 0 && /ATTR=TXT:UPS\b/i.test(step.raw)) {
        console.log(contextLabel(index, steps.length, inspectMode, `wait-ups-delay: ${upsDelayMs}ms`));
        await delay(upsDelayMs);
        upsDelayApplied = true;
      }

      const result = await executeStep(page, step, {
        clickDelayMs,
        inspectMode,
        stepLabel: `${index + 1}/${steps.length}`,
        nextStep: steps[index + 1],
        baseDir,
      });

      if (dumpStep && Number(dumpStep) === index + 1) {
        await page.screenshot({ path: `step-${dumpStep}.png`, fullPage: false }).catch(() => {});
      }

      if (result && result.consumedNextStep) {
        index += 1;
      }

      if (startUpsOnly && !upsModeStarted && /ATTR=TXT:MASUK\b/i.test(step.raw)) {
        skipUntilUps = true;
      }
    }
  } finally {
    if (!keepBrowserOpen) {
      await browser.close();
    }
  }
}

function contextLabel(index, total, inspectMode, message) {
  return inspectMode ? `[${index + 1}/${total}] ${message}` : message;
}

module.exports = {
  runMacroFile,
};
