function decodeImacrosText(value = "") {
  return String(value)
    .replace(/<SP>/g, " ")
    .replace(/<BR>/g, "\n")
    .trim();
}

function parseAttrParts(attrText = "") {
  const attrs = {};
  const parts = attrText.split("&&").map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) {
      attrs[part] = true;
      continue;
    }
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    attrs[key] = decodeImacrosText(rawValue);
  }

  return attrs;
}

function parseMacroLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith("//")) {
    return null;
  }

  if (/^VERSION\b/i.test(trimmed)) {
    return { type: "noop", raw: trimmed };
  }

  if (/^TAB\b/i.test(trimmed)) {
    return { type: "noop", raw: trimmed };
  }

  if (/^SET\b/i.test(trimmed)) {
    return { type: "noop", raw: trimmed };
  }

  const waitMatch = trimmed.match(/^WAIT\s+SECONDS=(\d+(?:\.\d+)?)$/i);
  if (waitMatch) {
    return {
      type: "wait",
      seconds: Number(waitMatch[1]),
      raw: trimmed,
    };
  }

  const gotoMatch = trimmed.match(/^URL\s+GOTO=(.+)$/i);
  if (gotoMatch) {
    return {
      type: "goto",
      url: decodeImacrosText(gotoMatch[1]),
      raw: trimmed,
    };
  }

  const tagMatch = trimmed.match(
    /^TAG\s+POS=(\d+)\s+TYPE=([^\s]+)(?:\s+FORM=([^\s]+))?\s+ATTR=(.*?)(?:\s+CONTENT=(.*))?$/i
  );

  if (tagMatch) {
    const [, pos, elementType, form, attrText, content] = tagMatch;
    return {
      type: "tag",
      pos: Number(pos),
      elementType,
      form,
      attrs: parseAttrParts(attrText),
      content: content !== undefined ? decodeImacrosText(content) : null,
      raw: trimmed,
    };
  }

  return { type: "unknown", raw: trimmed };
}

function parseMacroText(text) {
  return text
    .split(/\r?\n/)
    .map(parseMacroLine)
    .filter(Boolean);
}

module.exports = {
  decodeImacrosText,
  parseAttrParts,
  parseMacroLine,
  parseMacroText,
};
