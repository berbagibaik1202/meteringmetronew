#!/usr/bin/env node

require("dotenv").config();

const fs = require("fs/promises");
const readline = require("readline/promises");
const path = require("path");
const { stdin: input, stdout: output } = require("process");
const { runMacroFile } = require("./src/runner");

async function loadVariantProfile(variantId) {
  const variationsPath = path.resolve(process.cwd(), "variations.json");
  const raw = await fs.readFile(variationsPath, "utf8");
  const config = JSON.parse(raw);
  const selectedId = String(variantId || config.defaultVariant || "1");
  const profile = config.variants?.[selectedId];

  if (!profile) {
    throw new Error(`Profil variasi tidak ditemukan: ${selectedId}`);
  }

  return { id: selectedId, profile };
}

function applyVariantProfile(profile) {
  for (const [key, value] of Object.entries(profile)) {
    if (value !== undefined && value !== null) {
      process.env[key] = String(value);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const fileArg = args.find((arg) => !arg.startsWith("-"));
  const macroPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), "IMACROSTXDIGITAL.txt");

  const inspectMode = args.includes("--inspect");
  const headless = !(args.includes("--headed") || inspectMode);
  const slowMoArg = args.find((arg) => arg.startsWith("--slowMo="));
  const slowMo = inspectMode
    ? 120
    : slowMoArg
      ? Number(slowMoArg.split("=")[1]) || 0
      : 0;
  const clickDelayArg = args.find((arg) => arg.startsWith("--clickDelay="));
  const clickDelayMs = inspectMode
    ? 1000
    : clickDelayArg
      ? Number(clickDelayArg.split("=")[1]) || 400
      : 400;
  const repeatArg = args.find((arg) => arg === "--repeat" || arg.startsWith("--repeat="));
  const repeatMode = Boolean(repeatArg);
  const repeatCount = repeatArg && repeatArg.includes("=")
    ? Number(repeatArg.split("=")[1]) || 0
    : 0;
  const startUpsOnly = args.includes("--start-ups");
  const noSandbox = args.includes("--no-sandbox");
  const dumpStepArg = args.find((arg) => arg.startsWith("--dump-step="));
  const dumpStep = dumpStepArg ? Number(dumpStepArg.split("=")[1]) || null : null;
  const variantArg = args.find((arg) => arg.startsWith("--variant="));
  const requestedVariant = variantArg ? variantArg.split("=")[1] : null;

  const { id: variantId, profile } = await loadVariantProfile(requestedVariant);
  applyVariantProfile(profile);

  let iteration = 0;
  while (true) {
    iteration += 1;
    await runMacroFile(macroPath, {
      headless,
      slowMo,
      clickDelayMs,
      inspectMode,
      startUpsOnly,
      dumpStep,
      noSandbox,
      keepBrowserOpen: false,
    });

    if (!repeatMode) {
      break;
    }

    if (repeatCount > 0 && iteration >= repeatCount) {
      break;
    }

    const rl = readline.createInterface({ input, output });
    await rl.question(
      `Siklus ${iteration} selesai untuk variasi ${variantId}. Edit IMACROSTXDIGITAL.txt jika perlu, lalu tekan Enter untuk mengulang.`
    );
    rl.close();
  }
}

function printHelp() {
  console.log(`
Usage:
  node index.js [--headed] [--inspect] [--start-ups] [--no-sandbox] [--variant=N] [--dump-step=N] [--repeat[=N]] [--slowMo=ms] [--clickDelay=ms]

Examples:
  node index.js
  node index.js IMACROSTXDIGITAL.txt --inspect
  node index.js --headed
  node index.js --start-ups
  node index.js --variant=2
  node index.js --start-ups --dump-step=42
  node index.js --inspect --repeat
  node index.js --repeat=5

Environment:
  LOGIN_USERNAME  Default username if macro uses placeholder
  LOGIN_PASSWORD  Default password if macro uses placeholder
  Placeholders in macro content support {{VARNAME}} and \${VARNAME}

Modes:
  --headed        Show the browser window.
  --inspect       Show the browser window and slow down the steps for identification.
  --start-ups     After login, skip TX Digital and jump to the UPS section.
  --no-sandbox    Force Chromium to run without sandbox, useful on root VPS.
  --variant=N     Load values/images from the selected variation in variations.json.
  --dump-step=N   Save a screenshot after step N as 'step-N.png'.
  --repeat        Rerun the macro after each cycle; press Enter to continue.
  --repeat=N      Rerun the macro N times total.

Notes:
  - This runner supports a useful subset of iMacros commands found in your files.
  - If a selector is too dynamic, you may need to tune it in src/runner.js.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
