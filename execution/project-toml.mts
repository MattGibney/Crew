const FILE_LIMIT = 128 * 1024;
// Deliberately bounded TOML subset: string/scalar metadata, [setup], [[actions]].
// Reject unsupported syntax rather than execute a guessed or partial command.
export function parseProjectEnvironmentToml(content: string) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > FILE_LIMIT ||
    content.includes("\0")
  ) {
    throw new Error("Environment TOML exceeds the supported text limit.");
  }
  const input = content.replace(/^\uFEFF/, "");
  let index = 0;
  let section: Record<string, string> | null = null,
    setup: Record<string, string> | null = null;
  const actions: Record<string, string>[] = [],
    seen = new Set<string>();
  function fail(detail: string): never {
    throw new Error(
      `Environment TOML: ${detail} (line ${input.slice(0, index).split("\n").length}).`,
    );
  }
  function horizontal() {
    while (
      input[index] === " " ||
      input[index] === "\t" ||
      input[index] === "\r"
    )
      index++;
  }
  function endLine() {
    horizontal();
    if (input[index] === "#")
      while (index < input.length && input[index] !== "\n") index++;
    if (index < input.length && input[index] !== "\n")
      fail("unsupported trailing syntax");
    if (input[index] === "\n") index++;
  }
  function string(): string {
    const quote = input[index],
      multiline = input.slice(index, index + 3) === quote.repeat(3);
    index += multiline ? 3 : 1;
    if (multiline && input.slice(index, index + 2) === "\r\n") index += 2;
    else if (multiline && input[index] === "\n") index++;
    let value = "";
    while (index < input.length) {
      if (
        input.slice(index, index + (multiline ? 3 : 1)) ===
        quote.repeat(multiline ? 3 : 1)
      ) {
        index += multiline ? 3 : 1;
        return value;
      }
      const char = input[index++];
      if (!multiline && (char === "\n" || char === "\r"))
        fail("newline in a single-line string");
      if (char === "\r" && input[index] === "\n") continue;
      if (char === "\\" && quote === '"') {
        if (multiline && /^[ \t\r\n]/.test(input[index] || "")) {
          const whitespace = /^[ \t\r\n]+/.exec(input.slice(index))?.[0] || "";
          if (!whitespace.includes("\n")) fail("invalid string escape");
          index += whitespace.length;
          continue;
        }
        const escaped = input[index++];
        const escapes: Record<string, string> = {
          b: "\b",
          t: "\t",
          n: "\n",
          f: "\f",
          r: "\r",
          '"': '"',
          "\\": "\\",
        };
        if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else if (escaped === "u" || escaped === "U") {
          const length = escaped === "u" ? 4 : 8,
            hex = input.slice(index, index + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex))
            fail("invalid Unicode escape");
          const code = parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
            fail("invalid Unicode code point");
          value += String.fromCodePoint(code);
          index += length;
        } else fail("unsupported string escape");
      } else {
        if (
          (char.charCodeAt(0) < 32 && !["\n", "\t", "\r"].includes(char)) ||
          char === "\u007f"
        )
          fail("control character in string");
        value += char;
      }
    }
    fail("unterminated string");
  }
  while (index < input.length) {
    horizontal();
    if (
      input[index] === "\n" ||
      input[index] === "#" ||
      index === input.length
    ) {
      endLine();
      continue;
    }
    if (input[index] === "[") {
      const end = input.indexOf("\n", index),
        line = input.slice(index, end < 0 ? input.length : end);
      const header = /^(\[\[?)([A-Za-z0-9_.-]+)(\]\]?)[ \t\r]*(?:#.*)?$/.exec(
        line,
      );
      if (!header || header[1].length !== header[3].length)
        fail("unsupported table syntax");
      index += line.length;
      if (header[2] === "setup" && header[1] === "[") {
        if (setup) fail("duplicate setup table");
        setup = {};
        section = setup;
      } else if (header[2] === "actions" && header[1] === "[[") {
        if (actions.length >= 32) fail("too many actions");
        section = {};
        actions.push(section);
      } else
        fail(
          "unsupported table; select a supported environment file or enter commands explicitly",
        );
      endLine();
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(input.slice(index));
    if (!match) fail("unsupported assignment syntax");
    const key = match[1];
    if (section ? Object.hasOwn(section, key) : seen.has(key))
      fail(`duplicate key ${key}`);
    index += match[0].length;
    let value;
    if (input[index] === '"' || input[index] === "'") value = string();
    else {
      const scalar = /^(?:true|false|[+-]?[0-9]+)(?=[ \t\r\n#]|$)/.exec(
        input.slice(index),
      );
      if (!scalar)
        fail(
          "unsupported value; only string and scalar metadata are supported",
        );
      value = scalar[0];
      index += scalar[0].length;
      if (key === "script" || key === "command" || key === "name")
        fail(`${key} must be a string`);
    }
    if (section) section[key] = value;
    else seen.add(key);
    endLine();
  }
  if (
    setup &&
    (typeof setup.script !== "string" ||
      !setup.script.trim() ||
      setup.script.includes("\0"))
  )
    throw new Error("Environment TOML setup.script must be a nonempty string.");
  for (const action of actions) {
    if (
      typeof action.name !== "string" ||
      !action.name.trim() ||
      typeof action.command !== "string" ||
      !action.command.trim() ||
      action.command.includes("\0")
    ) {
      throw new Error(
        "Environment TOML actions require nonempty name and command strings.",
      );
    }
  }
  return {
    setup: setup ? { command: setup.script } : null,
    actions: actions.map(({ name, command }) => ({ name, command })),
  };
}

// Mask quoted strings and comments before inspecting this single permission.
// Strings spanning lines cannot spoof a section or setting inside their content.
export function parseProjectNetworkAccess(content: string) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > FILE_LIMIT ||
    content.includes("\0")
  ) {
    throw new Error(
      "Codex permission config exceeds the supported text limit.",
    );
  }
  let masked = "";
  let quote: string | null = null,
    triple = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quote) {
      if (char === "\\" && quote === '"') {
        const next = content[++index];
        if (next === undefined || (!triple && (next === "\n" || next === "\r")))
          throw new Error("Malformed quoted permission config.");
        masked += next === "\n" ? " \n" : "  ";
      } else if (
        char === quote &&
        (!triple || content.slice(index, index + 3) === quote.repeat(3))
      ) {
        masked += triple ? "   " : " ";
        index += triple ? 2 : 0;
        quote = null;
      } else {
        if (!triple && (char === "\n" || char === "\r"))
          throw new Error("Malformed quoted permission config.");
        masked += char === "\n" ? "\n" : " ";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      triple = content.slice(index, index + 3) === char.repeat(3);
      masked += triple ? "   " : " ";
      index += triple ? 2 : 0;
    } else if (char === "#") {
      while (index < content.length && content[index] !== "\n") index++;
      masked += "\n";
    } else masked += char;
  }
  if (quote) throw new Error("Unterminated string in Codex permission config.");
  let relevant = false,
    declared = false,
    result: boolean | null = null,
    sectionSeen = false;
  for (const line of masked.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("[")) {
      const header = /^(\[\[?)([A-Za-z0-9_.-]+)(\]\]?)$/.exec(text);
      if (!header || header[1].length !== header[3].length)
        throw new Error("Unsupported permission config table syntax.");
      relevant = text === "[sandbox_workspace_write]";
      if (relevant && sectionSeen)
        throw new Error("Duplicate sandbox_workspace_write permission table.");
      if (relevant) sectionSeen = true;
      continue;
    }
    if (!relevant) continue;
    if (/^network_access(?:\s|=|$)/.test(text)) {
      const value = /^network_access\s*=\s*(true|false)$/.exec(text);
      if (!value || declared)
        throw new Error(
          "network_access must be declared once as a TOML boolean.",
        );
      declared = true;
      result = value[1] === "true";
    }
  }
  return result;
}
