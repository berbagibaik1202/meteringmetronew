#!/usr/bin/env node

const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const projectRoot = __dirname;
const variationsPath = path.resolve(projectRoot, "variations.json");
const userPath = path.resolve(projectRoot, "user.json");
const cronjobPath = path.resolve(projectRoot, "cronjob.txt");
const port = Number(process.env.WEB_PORT || 1989);
const host = process.env.WEB_HOST || "0.0.0.0";
const sessionCookieName = "metro_web_session";
const flashCookieName = "metro_web_flash";
const cronCommand = process.env.CRON_BIN || "/usr/bin/crontab";
const cronUser = process.env.CRON_USER || "ubuntu";
const runLogPath = path.resolve(projectRoot, "log", "web-runs.log");
const sessions = new Map();

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeFileName(value = "") {
  return String(value || "").trim();
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listVariationFiles() {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^variations.*\.json$/i.test(name))
    .sort((a, b) => {
      if (a === "variations.json") return -1;
      if (b === "variations.json") return 1;
      return a.localeCompare(b);
    });
}

async function listEditableFiles() {
  const variationFiles = await listVariationFiles();
  return ["user.json", ...variationFiles];
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function runCommand(command, args = [], { input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(input);
  });
}

async function startManualRun(variant, mode) {
  const normalizedVariant = String(variant || "").trim();
  if (!/^\d+$/.test(normalizedVariant)) {
    throw new Error("Variant harus berupa angka.");
  }
  if (!["tx", "ups"].includes(mode)) {
    throw new Error("Mode harus TX atau UPS.");
  }

  await fs.mkdir(path.dirname(runLogPath), { recursive: true });
  const logHandle = await fs.open(runLogPath, "a");
  const args = [path.resolve(projectRoot, "index.js"), `--variant=${normalizedVariant}`, "--no-sandbox", "--slowMo=500", "--clickDelay=1500"];
  args.push(mode === "ups" ? "--start-ups" : "--tx-only");

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  return child.pid;
}

function getEffectiveUsername() {
  try {
    if (typeof process.geteuid === "function" && typeof process.getuid === "function") {
      return process.geteuid() === 0 ? "root" : process.env.USER || process.env.USERNAME || "unknown";
    }
  } catch {
    // ignore
  }

  return process.env.USER || process.env.USERNAME || "unknown";
}

function getCrontabArgs(operation) {
  const args = [];
  const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
  if (isRoot) {
    args.push("-u", cronUser);
  }
  args.push(operation);
  return args;
}

function normalizeCronText(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^(\s*)\\#/gm, "$1#");
}

function validateCronText(text = "") {
  const lines = String(text || "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("@")) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) {
        return {
          ok: false,
          error: `Baris ${lineNumber} tidak valid: special schedule harus diikuti command.`,
        };
      }
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 6) {
      return {
        ok: false,
        error: `Baris ${lineNumber} tidak valid: cron job harus memiliki 5 field jadwal dan command.`,
      };
    }
  }

  return { ok: true };
}

function defaultUserConfig() {
  return {
    users: [
      {
        username: "admin",
        password: "admin123",
        label: "Administrator",
      },
    ],
  };
}

function normalizeUserConfig(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

  if (Array.isArray(parsed)) {
    return {
      users: parsed
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          username: String(item.username || item.user || item.login || "").trim(),
          password: String(item.password || item.pass || item.secret || "").trim(),
          label: String(item.label || item.name || item.username || item.user || "User").trim(),
        }))
        .filter((item) => item.username && item.password),
    };
  }

  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.users)) {
      return {
        users: parsed.users
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            username: String(item.username || item.user || item.login || "").trim(),
            password: String(item.password || item.pass || item.secret || "").trim(),
            label: String(item.label || item.name || item.username || item.user || "User").trim(),
          }))
          .filter((item) => item.username && item.password),
      };
    }

    if (parsed.username || parsed.password) {
      const username = String(parsed.username || parsed.user || parsed.login || "").trim();
      const password = String(parsed.password || parsed.pass || parsed.secret || "").trim();
      return {
        users: username && password
          ? [{
            username,
            password,
            label: String(parsed.label || parsed.name || username).trim(),
          }]
          : [],
      };
    }
  }

  return { users: [] };
}

async function ensureUserFile() {
  if (!(await fileExists(userPath))) {
    await fs.writeFile(userPath, `${JSON.stringify(defaultUserConfig(), null, 2)}\n`, "utf8");
  }
}

async function readUserConfig() {
  await ensureUserFile();
  const raw = await fs.readFile(userPath, "utf8");
  const parsed = normalizeUserConfig(raw);
  return {
    users: parsed.users || [],
  };
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf("=");
      if (index === -1) {
        return acc;
      }
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function createFlashCookie(message = "") {
  return `${flashCookieName}=${encodeURIComponent(String(message || ""))}; HttpOnly; Path=/; Max-Age=10; SameSite=Lax`;
}

function clearFlashCookie() {
  return `${flashCookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function readFlashMessage(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[flashCookieName] ? String(cookies[flashCookieName]) : "";
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[sessionCookieName];
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  return session;
}

function redirectToLogin(res, error = "") {
  const location = error
    ? `/login?error=${encodeURIComponent(error)}`
    : "/login";
  res.writeHead(302, { Location: location });
  res.end();
}

function requireAuth(req, res) {
  const session = getSessionUser(req);
  if (!session) {
    return false;
  }

  return true;
}

function createSession(username) {
  const token = crypto.randomUUID();
  sessions.set(token, {
    username,
    createdAt: Date.now(),
  });
  return token;
}

function clearSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[sessionCookieName];
  if (token) {
    sessions.delete(token);
  }

  res.writeHead(302, {
    "Set-Cookie": `${sessionCookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    Location: "/login",
  });
  res.end();
}

function resolveEditableTarget(fileName, files) {
  const requested = normalizeFileName(fileName);
  if (requested && files.includes(requested)) {
    return requested;
  }

  if (files.includes("variations.json")) {
    return "variations.json";
  }

  return files[0] || "variations.json";
}

async function readCurrentSummary() {
  if (!(await fileExists(variationsPath))) {
    return {
      exists: false,
      file: "variations.json",
      defaultVariant: "-",
      variantCount: 0,
      username: "-",
    };
  }

  const data = await readJson(variationsPath);
  const defaultVariant = String(data.defaultVariant || "-");
  const variants = data.variants && typeof data.variants === "object" ? Object.values(data.variants) : [];
  const firstVariant = variants[0] || {};

  return {
    exists: true,
    file: "variations.json",
    defaultVariant,
    variantCount: variants.length,
    username: String(firstVariant.LOGIN_USERNAME || "-"),
  };
}

async function readUserSummary() {
  const config = await readUserConfig();
  const firstUser = config.users[0] || {};
  return {
    count: config.users.length,
    username: String(firstUser.username || "-"),
  };
}

async function readCurrentCrontab() {
  try {
    const result = await runCommand(cronCommand, getCrontabArgs("-l"));
    if (result.code === 0) {
      return { ok: true, text: normalizeCronText(result.stdout || "") };
    }

    if (/no crontab for/i.test(result.stderr || "")) {
      return { ok: true, text: "" };
    }

    return {
      ok: false,
      text: "",
      error: result.stderr.trim() || `crontab -l gagal dengan code ${result.code}`,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      error: err.message || "Gagal membaca crontab.",
    };
  }
}

async function readCronjobTemplate() {
  if (!(await fileExists(cronjobPath))) {
    return "";
  }

  return normalizeCronText(await fs.readFile(cronjobPath, "utf8"));
}

async function readCronText(source = "active") {
  if (source === "file") {
    return {
      source: "file",
      label: "cronjob.txt",
      ...(await (async () => {
        try {
          return { ok: true, text: await readCronjobTemplate() };
        } catch (err) {
          return { ok: false, text: "", error: err.message || "Gagal membaca cronjob.txt." };
        }
      })()),
    };
  }

  const active = await readCurrentCrontab();
  return {
    source: "active",
    label: "crontab aktif",
    ...active,
  };
}

async function writeCurrentCrontab(text) {
  const result = await runCommand(cronCommand, getCrontabArgs("-"), { input: String(text || "") });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `crontab gagal dengan code ${result.code}`);
  }
}

async function summarizeVariationFile(fileName) {
  const targetPath = path.resolve(projectRoot, fileName);
  try {
    const data = await readJson(targetPath);
    const variants = data.variants && typeof data.variants === "object" ? Object.values(data.variants) : [];
    const firstVariant = variants[0] || {};
    return {
      file: fileName,
      exists: true,
      defaultVariant: String(data.defaultVariant || "-"),
      variantCount: variants.length,
      username: String(firstVariant.LOGIN_USERNAME || "-"),
    };
  } catch {
    return {
      file: fileName,
      exists: false,
      defaultVariant: "-",
      variantCount: 0,
      username: "-",
    };
  }
}

async function loadVariationSummaries(files) {
  return Promise.all(files.map((file) => summarizeVariationFile(file)));
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readEditableJson(fileName = "variations.json") {
  const targetPath = path.resolve(projectRoot, normalizeFileName(fileName) || "variations.json");

  if (!(await fileExists(targetPath))) {
    if (path.basename(targetPath) === "user.json") {
      return JSON.stringify(defaultUserConfig(), null, 2);
    }
    return JSON.stringify({ defaultVariant: "1", variants: {} }, null, 2);
  }

  return fs.readFile(targetPath, "utf8");
}

function renderLoginPage({ message = "", error = "" } = {}) {
  const statusBox = message
    ? `<div class="notice success">${escapeHtml(message)}</div>`
    : error
      ? `<div class="notice error">${escapeHtml(error)}</div>`
      : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Metro Login</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f16;
      --panel: #121826;
      --border: rgba(255,255,255,.10);
      --text: #e9eef7;
      --muted: #94a3b8;
      --accent: #4f8cff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top left, rgba(79,140,255,.16), transparent 30%),
        radial-gradient(circle at bottom right, rgba(34,197,94,.10), transparent 26%),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      padding: 20px;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 24px;
      box-shadow: 0 20px 80px rgba(0,0,0,.35);
      backdrop-filter: blur(12px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      letter-spacing: -0.03em;
    }
    .sub {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.6;
    }
    .form {
      display: grid;
      gap: 14px;
    }
    label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    input, button {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(9, 14, 22, .9);
      color: var(--text);
      padding: 14px 16px;
      font: inherit;
    }
    button {
      cursor: pointer;
      border: none;
      background: linear-gradient(135deg, var(--accent), #6f5bff);
      font-weight: 700;
    }
    .notice {
      margin: 0 0 16px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.03);
    }
    .notice.success { border-color: rgba(34,197,94,.35); }
    .notice.error { border-color: rgba(239,68,68,.35); }
    .hint {
      margin-top: 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Metro Login</h1>
    <p class="sub">Masuk dulu untuk membuka panel utama dan mengelola variations.</p>
    ${statusBox}
    <form class="form" method="post" action="/api/login">
      <label>
        Username
        <input name="username" autocomplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autocomplete="current-password" required />
      </label>
      <button type="submit">Masuk</button>
    </form>
    <div class="hint">
      Kredensial awal disimpan di <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">user.json</span>.
    </div>
  </div>
</body>
</html>`;
}

function htmlPage({ files, summaries, current, userSummary, sessionUser, message, error, editorValue, editorFile, openEditor, openCron = false, cronText = "", cronError = "", flashMessage = "" }) {
  const selectedFile = editorFile || "variations.json";
  const fileCards = summaries.map((item) => {
    const isActive = item.file === selectedFile;
    const openHref = `/?file=${encodeURIComponent(item.file)}`;
    const editHref = `/?file=${encodeURIComponent(item.file)}&open=1#editor-modal`;
    const copyAction = `/api/replace`;
    return `
      <div class="file-card ${isActive ? "active" : ""}">
        <div class="file-card-head">
          <div>
            <div class="file-name">${escapeHtml(item.file)}</div>
            <div class="file-meta">${item.exists ? "Siap diedit" : "File tidak terbaca"}</div>
          </div>
          ${isActive ? '<span class="badge">Aktif dibuka</span>' : ""}
        </div>
        <div class="file-stats">
          <div><span>Default</span><strong>${escapeHtml(item.defaultVariant)}</strong></div>
          <div><span>User</span><strong>${escapeHtml(item.username)}</strong></div>
          <div><span>Variant</span><strong>${escapeHtml(String(item.variantCount))}</strong></div>
        </div>
        <div class="toolbar" style="margin-top: 14px;">
          <a class="button-link" href="${editHref}">Edit</a>
          <form method="post" action="${copyAction}">
            <input type="hidden" name="file" value="${escapeHtml(item.file)}" />
            <button type="submit">Salin ke variations.json</button>
          </form>
        </div>
      </div>
    `;
  }).join("");
  const statusBox = message
    ? `<div class="notice success">${escapeHtml(message)}</div>`
    : error
      ? `<div class="notice error">${escapeHtml(error)}</div>`
      : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Metro Variations</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f16;
      --panel: #121826;
      --panel-2: #0f1622;
      --border: rgba(255,255,255,.10);
      --text: #e9eef7;
      --muted: #94a3b8;
      --accent: #4f8cff;
      --accent-2: #22c55e;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(79,140,255,.14), transparent 30%),
        radial-gradient(circle at top right, rgba(34,197,94,.10), transparent 26%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1040px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero {
      display: grid;
      gap: 16px;
      grid-template-columns: 1.5fr .9fr;
      align-items: stretch;
      margin-bottom: 20px;
    }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 22px;
      box-shadow: 0 20px 80px rgba(0,0,0,.25);
      backdrop-filter: blur(12px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 42px);
      letter-spacing: -0.03em;
    }
    .sub {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .hero-sub {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 12px;
    }
    .session-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(79,140,255,.28);
      background: rgba(79,140,255,.12);
      color: #c8d7ff;
      font-size: 13px;
      font-weight: 700;
    }
    .logout-form {
      margin: 0;
    }
    .logout-button {
      width: auto;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border);
      font-weight: 700;
    }
    .statgrid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .stat {
      background: rgba(255,255,255,.03);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
    }
    .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .stat .value { font-size: 22px; margin-top: 8px; font-weight: 700; }
    .form {
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }
    label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    select, button, input {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(9, 14, 22, .85);
      color: var(--text);
      padding: 14px 16px;
      font: inherit;
    }
    select:focus, button:focus, input:focus {
      outline: 2px solid rgba(79,140,255,.35);
      outline-offset: 2px;
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent), #6f5bff);
      border: none;
      font-weight: 700;
    }
    button:hover { filter: brightness(1.04); }
    .toolbar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(9, 14, 22, .85);
      border: 1px solid var(--border);
      color: var(--text);
      font-weight: 700;
    }
    .secondary-link {
      background: rgba(255,255,255,.03);
    }
    .notice {
      margin: 18px 0 0;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.03);
    }
    .notice.success { border-color: rgba(34,197,94,.35); }
    .notice.error { border-color: rgba(239,68,68,.35); }
    .list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      line-height: 1.7;
    }
    .footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 13px;
    }
    .currentfile {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      word-break: break-all;
    }
    .editor {
      width: 100%;
      min-height: 420px;
      resize: vertical;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: rgba(9, 14, 22, .92);
      color: var(--text);
      padding: 16px;
      font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }
    .files-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .file-card {
      border: 1px solid var(--border);
      background: rgba(255,255,255,.03);
      border-radius: 18px;
      padding: 16px;
    }
    .file-card.active {
      border-color: rgba(79,140,255,.35);
      box-shadow: 0 0 0 1px rgba(79,140,255,.12) inset;
    }
    .file-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
    }
    .file-name {
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .file-meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(79,140,255,.15);
      border: 1px solid rgba(79,140,255,.35);
      color: #b9ccff;
      font-size: 12px;
      white-space: nowrap;
    }
    .file-stats {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .file-stats span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .file-stats strong {
      display: block;
      font-size: 15px;
      font-weight: 700;
      word-break: break-word;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, .72);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 50;
    }
    .modal-backdrop.open {
      display: flex;
    }
    .modal {
      width: min(980px, 100%);
      max-height: min(90vh, 920px);
      overflow: auto;
      background: linear-gradient(180deg, rgba(18,24,38,.98), rgba(12,18,28,.98));
      border: 1px solid var(--border);
      border-radius: 22px;
      box-shadow: 0 30px 100px rgba(0,0,0,.45);
      padding: 20px;
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 14px;
    }
    .modal-title {
      margin: 0;
      font-size: 22px;
      letter-spacing: -0.03em;
    }
    .modal-close {
      width: auto;
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border);
      font-weight: 700;
    }
    .modal-actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .flash-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, .62);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 60;
    }
    .flash-backdrop.open {
      display: flex;
    }
    .flash-card {
      width: min(460px, 100%);
      background: linear-gradient(180deg, rgba(18,24,38,.98), rgba(12,18,28,.98));
      border: 1px solid rgba(34,197,94,.35);
      border-radius: 20px;
      box-shadow: 0 30px 100px rgba(0,0,0,.45);
      padding: 20px;
    }
    .flash-card h3 {
      margin: 0 0 8px;
      font-size: 20px;
    }
    .flash-card p {
      margin: 0 0 16px;
      color: var(--muted);
      line-height: 1.6;
    }
    .cron-textarea {
      min-height: 280px;
      font-size: 12px;
    }
    .cron-tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .manual-run {
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid rgba(79,140,255,.25);
      border-radius: 14px;
      background: rgba(79,140,255,.07);
    }
    .run-form {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: end;
    }
    .run-form label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 860px) {
      .hero { grid-template-columns: 1fr; }
      .files-grid { grid-template-columns: 1fr; }
      .file-stats { grid-template-columns: 1fr; }
      .modal { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="card">
        <h1>Metro Variations</h1>
        <p class="sub">
          Pilih file variasi dari web, edit langsung isi JSON-nya, lalu simpan tanpa masuk terminal.
          Jika ingin mengaktifkan file itu untuk cron, salin ke <span class="currentfile">variations.json</span>.
        </p>
        <div class="hero-sub">
          <span class="session-chip">Login: ${escapeHtml(sessionUser?.username || "-")}</span>
          <span class="session-chip">User config: ${escapeHtml(String(userSummary?.count || 0))}</span>
          <form class="logout-form" method="post" action="/api/logout">
            <button class="logout-button" type="submit">Keluar</button>
          </form>
          <a class="button-link secondary-link" href="/?file=${encodeURIComponent(selectedFile)}&open=1#editor-modal">Buka editor</a>
        </div>

        ${statusBox}

        <div class="manual-run" style="margin-top: 18px;">
          <div>
            <strong>Jalankan manual</strong>
            <div class="hint">Browser tetap headless. Hasil proses dicatat di log/web-runs.log.</div>
          </div>
          <form class="run-form" method="post" action="/api/run">
            <label>Variant
              <select name="variant" required>
                ${[1, 2, 3, 4].map((variant) => `<option value="${variant}">Variant ${variant}</option>`).join("")}
              </select>
            </label>
            <label>Bagian
              <select name="mode" required>
                <option value="tx">TX Digital saja</option>
                <option value="ups">UPS saja</option>
              </select>
            </label>
            <button type="submit">Jalankan</button>
          </form>
        </div>

        <div class="toolbar" style="margin-top: 18px;">
          <a class="button-link" href="/?file=${encodeURIComponent(selectedFile)}&open=1#editor-modal">Buka editor</a>
          <a class="button-link secondary-link" href="/?openCron=1#cron-modal">Lihat crontab aktif</a>
        </div>

        <div class="hero-sub" style="margin-top: 18px;">
          <span class="session-chip">Edit dan salin ada di tiap kartu file.</span>
          <span class="session-chip">Gunakan popup editor untuk ubah JSON.</span>
        </div>
      </div>

      <div class="card">
        <div class="statgrid">
          <div class="stat">
            <div class="label">Current file</div>
            <div class="value currentfile">${escapeHtml(current.file)}</div>
          </div>
          <div class="stat">
            <div class="label">Default variant</div>
            <div class="value">${escapeHtml(current.defaultVariant)}</div>
          </div>
          <div class="stat">
            <div class="label">Username sample</div>
            <div class="value">${escapeHtml(current.username)}</div>
          </div>
          <div class="stat">
            <div class="label">Variant count</div>
            <div class="value">${escapeHtml(String(current.variantCount))}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px;">
      <h2 style="margin:0 0 10px; font-size: 20px;">Daftar file variasi</h2>
      <p class="sub" style="margin-bottom: 14px;">
        Klik edit untuk membuka popup editor. Tombol salin akan menyalin file itu ke <span class="currentfile">variations.json</span>.
      </p>
      <div class="files-grid">
        ${fileCards}
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px; font-size: 20px;">Cara pakai</h2>
      <ol class="list">
        <li>Pilih file yang ingin diedit, misalnya <span class="currentfile">variationsnana.json</span>.</li>
        <li>Klik <strong>Edit</strong> untuk membuka popup editor.</li>
        <li>Edit JSON lalu klik <strong>Simpan file ini</strong>.</li>
        <li>Kalau ingin dipakai cron, klik <strong>Salin file ini ke variations.json</strong>.</li>
      </ol>
      <div class="footer">
        Panel ini hanya menulis file di server lokal, tidak mengubah cronjob.
      </div>
    </div>

  </div>

  <div id="flash-popup" class="flash-backdrop${flashMessage ? " open" : ""}">
    <div class="flash-card" role="status" aria-live="polite">
      <h3>Berhasil</h3>
      <p>${escapeHtml(flashMessage)}</p>
      <div class="toolbar">
        <button type="button" id="flash-close">Tutup</button>
      </div>
    </div>
  </div>

  <div id="cron-modal" class="modal-backdrop${openCron ? " open" : ""}">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cron-title">
      <div class="modal-head">
        <div>
          <h2 id="cron-title" class="modal-title">Crontab Aktif</h2>
          <p class="sub" style="margin-top: 6px;">
            Yang tampil ini adalah crontab user <strong>${escapeHtml(cronUser)}</strong>.
          </p>
        </div>
        <a class="button-link modal-close" href="/">Tutup</a>
      </div>

      <p class="sub" style="margin-bottom: 14px;">
        Baris komentar yang diawali <span class="currentfile">\#</span> akan dibersihkan otomatis menjadi <span class="currentfile">#</span> saat tampil dan saat simpan.
      </p>

      ${cronError ? `<div class="notice error" style="margin-top:0;">${escapeHtml(cronError)}</div>` : ""}

      <form class="form" method="post" action="/api/cron">
        <label>
          Isi crontab
          <textarea class="editor cron-textarea" name="cron" spellcheck="false">${escapeHtml(cronText)}</textarea>
        </label>
        <div class="modal-actions">
          <button type="submit">Simpan crontab</button>
        </div>
      </form>
    </div>
  </div>

  <div id="editor-modal" class="modal-backdrop${openEditor ? " open" : ""}">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <div class="modal-head">
        <div>
          <h2 id="editor-title" class="modal-title">Edit ${escapeHtml(editorFile || "variations.json")}</h2>
          <p class="sub" style="margin-top: 6px;">Popup editor untuk mengubah JSON tanpa memenuhi halaman utama.</p>
        </div>
        <a class="button-link modal-close" href="/">Tutup</a>
      </div>

      <form class="form" method="post" action="/api/save">
        <input type="hidden" name="file" value="${escapeHtml(editorFile || "variations.json")}" />
        <label>
          Isi file JSON
          <textarea class="editor" name="json" spellcheck="false">${escapeHtml(editorValue)}</textarea>
        </label>
        <div class="modal-actions">
          <button type="submit">Simpan file ini</button>
        </div>
      </form>

      <form class="form" method="post" action="/api/replace" style="margin-top: 12px;">
        <input type="hidden" name="file" value="${escapeHtml(editorFile || "variations.json")}" />
        <div class="modal-actions">
          <button type="submit">Salin file ini ke variations.json</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    (() => {
      const flash = document.getElementById('flash-popup');
      const flashClose = document.getElementById('flash-close');
      if (flash && flashClose) {
        const closeFlash = () => {
          flash.classList.remove('open');
          window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
        };
        flashClose.addEventListener('click', closeFlash);
        flash.addEventListener('click', (event) => {
          if (event.target === flash) {
            closeFlash();
          }
        });
      }
      const modal = document.getElementById('editor-modal');
      const openEditor = ${openEditor ? "true" : "false"};
      const wantsOpen = openEditor || location.hash === '#editor-modal';
      if (wantsOpen && modal) {
        modal.classList.add('open');
      }
      const cronModal = document.getElementById('cron-modal');
      const wantsCronOpen = ${openCron ? "true" : "false"} || location.hash === '#cron-modal';
      if (wantsCronOpen && cronModal) {
        cronModal.classList.add('open');
      }
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal && modal.classList.contains('open')) {
          window.location.href = '/';
        }
        if (event.key === 'Escape' && cronModal && cronModal.classList.contains('open')) {
          window.location.href = '/';
        }
      });
      if (modal) {
        modal.addEventListener('click', (event) => {
          if (event.target === modal) {
            window.location.href = '/';
          }
        });
      }
      if (cronModal) {
        cronModal.addEventListener('click', (event) => {
          if (event.target === cronModal) {
            window.location.href = '/';
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}

async function handleReplace(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyRaw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(bodyRaw);
  const selectedFile = normalizeFileName(params.get("file"));

  const files = await listVariationFiles();
  if (!files.includes(selectedFile)) {
    jsonResponse(res, 400, { ok: false, error: "File variasi tidak valid." });
    return;
  }

  const sourcePath = path.resolve(projectRoot, selectedFile);
  const targetPath = variationsPath;

  const sourceRaw = await fs.readFile(sourcePath, "utf8");
  JSON.parse(sourceRaw);
  await fs.writeFile(targetPath, sourceRaw, "utf8");

  res.writeHead(302, {
    "Set-Cookie": createFlashCookie(`variations.json berhasil diganti dari ${selectedFile}`),
    Location: "/",
  });
  res.end();
}

async function handleSave(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyRaw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(bodyRaw);
  const selectedFile = normalizeFileName(params.get("file"));
  const jsonText = params.get("json") || "";

  const files = await listEditableFiles();
  const targetFile = resolveEditableTarget(selectedFile, files);
  const targetPath = path.resolve(projectRoot, targetFile);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    res.writeHead(302, {
      Location: "/?file=" + encodeURIComponent(targetFile) + "&error=" + encodeURIComponent(`JSON tidak valid: ${err.message}`),
    });
    res.end();
    return;
  }

  if (targetFile === "user.json") {
    const normalized = normalizeUserConfig(parsed);
    if (!normalized.users.length) {
      res.writeHead(302, {
        Location: "/?file=user.json&error=" + encodeURIComponent("user.json harus berisi minimal satu kredensial."),
      });
      res.end();
      return;
    }
    await fs.writeFile(targetPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } else {
    await fs.writeFile(targetPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  res.writeHead(302, {
    "Set-Cookie": createFlashCookie(`${targetFile} berhasil disimpan`),
    Location: "/?file=" + encodeURIComponent(targetFile),
  });
  res.end();
}

async function handleCronSave(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyRaw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(bodyRaw);
  const cronText = normalizeCronText(params.get("cron") || "");
  const validation = validateCronText(cronText);

  if (!validation.ok) {
    res.writeHead(302, {
      Location: "/?openCron=1&error=" + encodeURIComponent(validation.error),
    });
    res.end();
    return;
  }

  try {
    await writeCurrentCrontab(cronText);
  } catch (err) {
    res.writeHead(302, {
      Location: "/?openCron=1&error=" + encodeURIComponent(`Gagal simpan crontab: ${err.message}`),
    });
    res.end();
    return;
  }

  res.writeHead(302, {
    "Set-Cookie": createFlashCookie("Crontab berhasil disimpan."),
    Location: "/",
  });
  res.end();
}

async function handleManualRun(req, res) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyRaw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(bodyRaw);
  const variant = params.get("variant") || "1";
  const mode = params.get("mode") || "tx";

  try {
    const pid = await startManualRun(variant, mode);
    const label = mode === "ups" ? "UPS saja" : "TX Digital saja";
    res.writeHead(302, {
      "Set-Cookie": createFlashCookie(`${label} Variant ${variant} dijalankan (PID ${pid}).`),
      Location: "/",
    });
  } catch (err) {
    res.writeHead(302, {
      Location: "/?error=" + encodeURIComponent(`Gagal menjalankan proses: ${err.message}`),
    });
  }
  res.end();
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const sessionUser = getSessionUser(req);

  if (req.method === "GET" && url.pathname === "/login") {
    const error = url.searchParams.get("error") || "";
    const message = url.searchParams.get("message") || "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderLoginPage({ message, error }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const bodyRaw = Buffer.concat(chunks).toString("utf8");
    const params = new URLSearchParams(bodyRaw);
    const username = normalizeFileName(params.get("username"));
    const password = normalizeFileName(params.get("password"));
    const config = await readUserConfig();
    const matched = config.users.find((item) => item.username === username && item.password === password);

    if (!matched) {
      redirectToLogin(res, "Username atau password salah.");
      return;
    }

    const token = createSession(matched.username);
    res.writeHead(302, {
      "Set-Cookie": `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${60 * 60 * 12}; SameSite=Lax`,
      Location: "/",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSession(req, res);
    return;
  }

  if (url.pathname !== "/login" && url.pathname !== "/api/login" && url.pathname !== "/api/logout") {
    const session = getSessionUser(req);
    if (!session) {
      if (url.pathname.startsWith("/api/")) {
        jsonResponse(res, 401, { ok: false, error: "login required" });
      } else {
        redirectToLogin(res);
      }
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const files = await listVariationFiles();
    const current = await readCurrentSummary();
    const userSummary = await readUserSummary();
    jsonResponse(res, 200, {
      ok: true,
      files,
      current,
      userSummary,
      sessionUser: sessionUser ? sessionUser.username : null,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/replace") {
    await handleReplace(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/save") {
    await handleSave(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cron") {
    await handleCronSave(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    await handleManualRun(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    const files = await listEditableFiles();
    const variationFiles = await listVariationFiles();
    const summaries = await loadVariationSummaries(variationFiles);
    const current = await readCurrentSummary();
    const userSummary = await readUserSummary();
    const editorFile = resolveEditableTarget(url.searchParams.get("file"), files);
    const editorValue = await readEditableJson(editorFile);
    const message = url.searchParams.get("message") || "";
    const error = url.searchParams.get("error") || "";
    const flashMessage = readFlashMessage(req);
    const openEditor = url.searchParams.get("open") === "1";
    const openCron = url.searchParams.get("openCron") === "1";
    const cronState = openCron ? await readCronText("active") : { ok: true, text: "" };
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (flashMessage) {
      headers["Set-Cookie"] = clearFlashCookie();
    }
    res.writeHead(200, headers);
    res.end(htmlPage({
      files,
      summaries,
      current,
      userSummary,
      sessionUser,
      message,
      error,
      editorValue,
      editorFile,
      openEditor,
      openCron,
      cronText: cronState.text,
      cronError: cronState.ok ? "" : cronState.error,
      flashMessage,
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

async function main() {
  if (!(await fileExists(variationsPath))) {
    await fs.writeFile(variationsPath, JSON.stringify({ defaultVariant: "1", variants: {} }, null, 2) + "\n", "utf8");
  }

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal server error");
    });
  });

  server.listen(port, host, () => {
    console.log(`Web control panel running at http://${host}:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
