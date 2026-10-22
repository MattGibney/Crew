import { createServer } from "node:http";
import {
  connect,
  createServer as createSocketServer,
  isIP,
  type Socket,
} from "node:net";
import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Model transport only. This proxy never receives service credentials or decrypts TLS.
 * A fixed public-host allowlist plus pinned DNS resolution prevents localhost/private
 * service access. Agents reach services only through their separate Crew endpoint. */
const MODEL_HOSTS = new Set([
  "chatgpt.com",
  "auth.openai.com",
  "api.openai.com",
]);
function publicIPv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a !== 169 &&
    a! < 224 &&
    !(a === 172 && b! >= 16 && b! <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 100 && b! >= 64 && b! <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}
export async function openModelEgress(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, client, head) => {
    client.on("error", () => {});
    void (async () => {
      const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? "");
      if (
        closed ||
        !match ||
        !MODEL_HOSTS.has(match[1]!) ||
        head.length > 16_384
      )
        throw new Error("Denied egress.");
      const answers = await lookup(match[1]!, { family: 4, all: true });
      if (
        closed ||
        client.destroyed ||
        !answers.length ||
        answers.some((answer) => !publicIPv4(answer.address))
      )
        throw new Error("Denied egress address.");
      const remote = connect({ host: answers[0]!.address, port: 443 });
      sockets.add(remote);
      remote.setTimeout(120_000, () => remote.destroy());
      remote.once("close", () => sockets.delete(remote));
      remote.once("error", () => client.destroy());
      client.once("error", () => remote.destroy());
      client.once("close", () => remote.destroy());
      remote.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote);
        remote.pipe(client);
      });
    })().catch(() => {
      client.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Model proxy unavailable.");
  return {
    port: address.port,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const quote = (value: string) => JSON.stringify(value);
/** Outer policy applies to app-server AND every descendant, including approved
 * commands. No user home, keychain, provider configuration or host socket roots. */
export function nativeSeatbeltPolicy(input: {
  root: string;
  executable: string;
  ports: number[];
  readRoots?: string[];
  writeRoots?: string[];
}): string {
  if (
    input.ports.some(
      (port) => !Number.isSafeInteger(port) || port < 1 || port > 65535,
    )
  )
    throw new Error("Invalid native endpoint.");
  return `(version 1)
(deny default)
(allow process-fork process-exec)
(allow process-info* (target self))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-map-executable)
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs.") (ipc-posix-name "apple.shm.notification_center"))
(allow user-preference-read (preference-domain "com.openai.codex"))
(allow file-read* (literal "/") (literal "/usr") (literal "/private") (literal "/private/etc")
 (subpath "/System") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/usr/share") (subpath "/bin")
 (subpath "/private/etc/ssl") (subpath "/private/var/db/timezone") (literal "/private/etc/localtime")
 (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
 (subpath ${quote(dirname(input.executable))})
 ${input.readRoots?.map((root) => `(subpath ${quote(root)})`).join(" ") ?? ""})
(allow file-read* file-write* (subpath ${quote(input.root)}))
${input.writeRoots?.map((root) => `(allow file-read* file-write* (subpath ${quote(root)}))`).join("\n") ?? ""}
(allow file-write* (literal "/dev/null"))
${input.ports.map((port) => `(allow network-outbound (remote tcp "localhost:${port}"))`).join("\n")}
`;
}

export async function boundedProcess(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let overflow = false;
    child.stderr.resume(); // Never retain native diagnostics containing configuration/auth.
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > 32_768) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Native boundary process unavailable."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      overflow
        ? reject(new Error("Native boundary output exceeded limit."))
        : resolve({ code, stdout });
    });
  });
}

/** Synthetic-only canaries. Never reads actual owner credentials/keychain items. */
export async function verifyNativeBoundary(
  profile: string,
  root: string,
  env: Record<string, string>,
): Promise<void> {
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "crew-boundary-canary-")),
  );
  const secret = randomUUID();
  const sentinel = join(outside, "service-secret");
  const own = join(root, ".boundary-canary");
  await writeFile(sentinel, secret, { mode: 0o600 });
  await writeFile(own, "owned", { mode: 0o600 });
  try {
    const run = (command: string, args: string[]) =>
      boundedProcess(
        "/usr/bin/sandbox-exec",
        ["-f", profile, command, ...args],
        env,
        root,
      );
    if ((await run("/bin/cat", [own])).stdout !== "owned")
      throw new Error("Owned native workspace unavailable.");
    const denied = await run("/bin/cat", [sentinel]);
    if (denied.code === 0 || denied.stdout.includes(secret))
      throw new Error("Host file isolation failed.");
    // A descendant shell retains the same boundary even without an inner Codex sandbox.
    const nested = await run("/bin/sh", [
      "-c",
      'exec /bin/cat "$1"',
      "crew-canary",
      sentinel,
    ]);
    if (nested.code === 0 || nested.stdout.includes(secret))
      throw new Error("Descendant boundary failed.");
    const process = await run("/bin/ps", [
      "-p",
      String(globalThis.process.pid),
      "-o",
      "command=",
    ]);
    if (process.code === 0 && process.stdout.trim())
      throw new Error("Host process isolation failed.");
    // Only the keychain-list operation, never a credential lookup. Discard output.
    // Nonexistence of a random item would not prove denied keychain access.
    const keychain = await run("/usr/bin/security", ["list-keychains"]);
    if (keychain.code === 0 || keychain.stdout.trim())
      throw new Error("Keychain isolation failed.");
    const host = createSocketServer((socket) =>
      socket.end("host-socket-canary"),
    );
    const unix = createSocketServer((socket) =>
      socket.end("unix-socket-canary"),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        host.once("error", reject);
        host.listen(0, "127.0.0.1", resolve);
      });
      const socketPath = join(outside, "host.sock");
      await new Promise<void>((resolve, reject) => {
        unix.once("error", reject);
        unix.listen(socketPath, resolve);
      });
      const address = host.address();
      if (!address || typeof address === "string")
        throw new Error("Socket canary unavailable.");
      const tcp = await run("/usr/bin/nc", [
        "-w",
        "1",
        "127.0.0.1",
        String(address.port),
      ]);
      const local = await run("/usr/bin/nc", ["-w", "1", "-U", socketPath]);
      if (
        tcp.code === 0 ||
        local.code === 0 ||
        tcp.stdout.includes("canary") ||
        local.stdout.includes("canary")
      )
        throw new Error("Host socket isolation failed.");
    } finally {
      host.close();
      unix.close();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(own, { force: true });
  }
  // Make sure the actual policy file still exists after the probes.
  if (!(await readFile(profile, "utf8")).startsWith("(version 1)"))
    throw new Error("Native policy unavailable.");
}
