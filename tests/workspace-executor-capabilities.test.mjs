import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runMacWorkspaceCommand as run,
  startMacWorkspaceProcess as start,
  inspectMacWorkspaceProcess as inspect,
  stopMacWorkspaceProcess as stop,
} from "../src/access/workspace-executor.mts";
import { WorkspaceProcessRecorder } from "../src/access/workspace-process-evidence.mts";

const mac = { skip: process.platform !== "darwin", concurrency: false };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-workspace-capabilities-")),
  );
  const workspace = join(root, "workspace"),
    controller = join(root, "controller");
  const cache = join(root, "cache"),
    outside = join(root, "outside");
  for (const directory of [workspace, controller, cache, outside])
    await mkdir(directory, { mode: 0o700 });
  const node = await realpath(process.execPath),
    bin = dirname(node);
  const receipts = [];
  t.after(async () => {
    for (const ref of receipts) {
      const result = await stop(controller, ref, { timeoutMs: 3000 });
      // Preserve private evidence if cleanup cannot prove exit; never kill an
      // unverified process or erase its receipt merely to make a test finish.
      assert.equal(
        result.processesSettled,
        true,
        `Unsettled fixture receipt ${ref} in ${root}`,
      );
    }
    await rm(root, { recursive: true, force: true });
  });
  const policy = {
    workspaceDirectory: workspace,
    privateDirectory: controller,
    writable: false,
    readableRoots: [],
    writableRoots: [cache],
    executableDirectories: [bin],
    environment: { CREW_TEMPLATE_MODE: "explicit", NPM_CONFIG_CACHE: cache },
  };
  return {
    root,
    workspace,
    controller,
    cache,
    outside,
    node,
    bin,
    policy,
    code: (source) => `${quote(node)} -e ${quote(source)}`,
    execute: (command, override = {}) =>
      run({ ...policy, ...override }, { command, timeoutMs: 10_000 }),
    async launch(command, override = {}) {
      const result = await start({ ...policy, ...override }, { command });
      if (result.processEvidenceRef) receipts.push(result.processEvidenceRef);
      return result;
    },
  };
}

test(
  "actual Node execution keeps explicit environment, readonly files and a separate writable cache",
  mac,
  async (t) => {
    const f = await fixture(t);
    const key = `CREW108_${randomUUID().replaceAll("-", "").toUpperCase()}_TOKEN`;
    process.env[key] = "synthetic-never-inherited";
    t.after(() => {
      delete process.env[key];
    });
    let result = await f.execute("node --version");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${process.versions.node}`);
    result = await f.execute(
      f.code(
        `if(process.env[${JSON.stringify(key)}] || process.env.CREW_TEMPLATE_MODE !== 'explicit') process.exit(1);require('fs').writeFileSync(${JSON.stringify(join(f.cache, "cache"))},'ok')`,
      ),
    );
    assert.equal(result.exitCode, 0, result.stderr);
    for (const name of ["PATH", "NODE_OPTIONS", "GITHUB_TOKEN", "HTTP_PROXY"]) {
      await assert.rejects(
        () => f.execute("true", { environment: { [name]: "synthetic" } }),
        /nonsecret/,
      );
    }
    for (const path of [
      join(f.outside, "canary"),
      join(f.controller, "canary"),
    ]) {
      await writeFile(path, "synthetic-protected-value");
      result = await f.execute(`/bin/cat ${quote(path)}`);
      assert.notEqual(result.exitCode, 0);
      assert(!result.stdout.includes("synthetic-protected-value"));
    }
    result = await f.execute(
      `echo denied > ${quote(join(f.workspace, "denied"))}`,
    );
    assert.notEqual(result.exitCode, 0);
  },
);

test(
  "a private controller below Library works without exposing Library command roots",
  mac,
  async (t) => {
    const f = await fixture(t);
    // This isolated owned fixture is unrelated to Crew defaults or any auth home.
    const controller = await realpath(
      await mkdtemp(join(homedir(), "Library", "crew-executor-private-test-")),
    );
    t.after(() => rm(controller, { recursive: true, force: true }));
    await writeFile(
      join(controller, "private-canary"),
      "synthetic-controller-only",
    );
    const result = await f.execute("node --version", {
      privateDirectory: controller,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${process.versions.node}`);
    assert.equal(result.processesSettled, true);
    const denied = await f.execute(
      `/bin/cat ${quote(join(controller, "private-canary"))}`,
      { privateDirectory: controller },
    );
    assert.notEqual(denied.exitCode, 0);
    assert(!denied.stdout.includes("synthetic-controller-only"));
    assert.equal(denied.processesSettled, true);
    // Being trusted controller storage never makes the same path an allowed
    // workspace, tool installation, readable mount, or writable cache.
    for (const field of [
      "workspaceDirectory",
      "readableRoots",
      "writableRoots",
      "executableDirectories",
    ]) {
      const override =
        field === "workspaceDirectory"
          ? { [field]: controller }
          : { [field]: [controller] };
      await assert.rejects(
        () => f.execute("true", override),
        /Broad or noncanonical/,
      );
    }
    await assert.rejects(
      () => f.execute("true", { privateDirectory: join(homedir(), "Library") }),
      /Broad or noncanonical/,
    );
  },
);

test(
  "prepared runtime HOME persists only isolated project configuration across commands",
  mac,
  async (t) => {
    const f = await fixture(t),
      path = join(f.root, "runtime-home");
    await mkdir(path, { mode: 0o700 });
    const stat = await lstat(path),
      runtimeHome = { path, device: stat.dev, inode: stat.ino };
    const first = await f.execute(
      f.code(
        "require('fs').writeFileSync(require('path').join(process.env.HOME,'project-setting'),'synthetic-persistent');",
      ),
      { runtimeHome },
    );
    assert.equal(first.exitCode, 0, first.stderr);
    const second = await f.execute(
      f.code(
        "process.stdout.write(require('fs').readFileSync(require('path').join(process.env.HOME,'project-setting'),'utf8'));",
      ),
      { runtimeHome },
    );
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(second.stdout, "synthetic-persistent");
    const fresh = await f.execute(
      f.code(
        "process.exit(require('fs').existsSync(require('path').join(process.env.HOME,'project-setting'))?1:0)",
      ),
    );
    assert.equal(fresh.exitCode, 0);
    await assert.rejects(
      () =>
        f.execute("true", {
          runtimeHome: { ...runtimeHome, inode: runtimeHome.inode + 1 },
        }),
      /runtime home identity/,
    );
    await assert.rejects(
      () =>
        f.execute("true", {
          environment: { DOCKER_HOST: "unix:///unapproved" },
        }),
      /nonsecret/,
    );
  },
);

test(
  "acknowledged broad host Docker capability grants only its exact synthetic Unix endpoint",
  mac,
  async (t) => {
    const f = await fixture(t),
      path = join(f.root, "docker-home");
    await mkdir(path, { mode: 0o700 });
    const homeStat = await lstat(path),
      runtimeHome = { path, device: homeStat.dev, inode: homeStat.ino };
    const socketPath = join(f.root, "d.sock"),
      otherPath = join(f.root, "o.sock");
    const daemon = createNetServer((socket) => socket.end("synthetic-daemon"));
    const other = createNetServer((socket) => socket.end("unapproved"));
    await new Promise((resolve) => daemon.listen(socketPath, resolve));
    await new Promise((resolve) => other.listen(otherPath, resolve));
    t.after(() => new Promise((resolve) => daemon.close(resolve)));
    t.after(() => new Promise((resolve) => other.close(resolve)));
    const socketStat = await lstat(socketPath);
    const hostDocker = {
      socketPath,
      device: socketStat.dev,
      inode: socketStat.ino,
      hostAccessAcknowledged: true,
    };
    await assert.rejects(
      () => f.execute("true", { hostDocker }),
      /acknowledgement.*isolated prepared home/,
    );
    await assert.rejects(
      () =>
        f.execute("true", {
          runtimeHome,
          hostDocker: { ...hostDocker, hostAccessAcknowledged: false },
        }),
      /acknowledgement/,
    );
    await assert.rejects(
      () =>
        f.execute("true", {
          runtimeHome,
          hostDocker: { ...hostDocker, inode: hostDocker.inode + 1 },
        }),
      /socket identity/,
    );
    const connected = await f.execute(
      f.code(
        `if(process.env.DOCKER_HOST!==${JSON.stringify("unix://" + socketPath)}||process.env.DOCKER_CONFIG!==require('path').join(process.env.HOME,'.docker'))process.exit(2);require('net').connect(process.env.DOCKER_HOST.slice(7)).on('data',chunk=>process.stdout.write(chunk)).on('error',()=>process.exit(3));`,
      ),
      { runtimeHome, hostDocker },
    );
    assert.equal(connected.exitCode, 0, connected.stderr);
    assert.equal(connected.stdout, "synthetic-daemon");
    const denied = await f.execute(
      f.code(
        `require('net').connect(${JSON.stringify(otherPath)}).on('connect',()=>process.exit(1)).on('error',()=>process.exit(0));`,
      ),
      { runtimeHome, hostDocker },
    );
    assert.equal(denied.exitCode, 0, denied.stderr);
    await writeFile(join(f.root, "host-canary"), "synthetic-host-value");
    const readDenied = await f.execute(
      `/bin/cat ${quote(join(f.root, "host-canary"))}`,
      { runtimeHome, hostDocker },
    );
    assert.notEqual(readDenied.exitCode, 0);
    assert(!readDenied.stdout.includes("synthetic-host-value"));
    assert.equal((await lstat(join(path, ".docker"))).mode & 0o077, 0);
  },
);

test(
  "actual npm installs a disposable local package offline without ambient npm configuration",
  mac,
  async (t) => {
    const f = await fixture(t);
    const npmRoot = join(dirname(f.bin), "lib/node_modules/npm");
    try {
      await access(join(npmRoot, "bin/npm-cli.js"));
    } catch {
      t.skip("The Node installation has no adjacent npm package.");
      return;
    }
    const override = { writable: true, readableRoots: [npmRoot] };
    let result = await f.execute("npm --version", override);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
    await mkdir(join(f.workspace, "local-package"));
    await writeFile(
      join(f.workspace, "local-package/package.json"),
      JSON.stringify({ name: "crew-local-fixture", version: "1.0.0" }),
    );
    await writeFile(
      join(f.workspace, "package.json"),
      JSON.stringify({
        name: "crew-disposable-app",
        version: "1.0.0",
        private: true,
      }),
    );
    result = await f.execute(
      "npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false ./local-package",
      override,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      await readFile(
        join(f.workspace, "node_modules/crew-local-fixture/package.json"),
        "utf8",
      ),
      /crew-local-fixture/,
    );
  },
);

test(
  "network is explicit, Unix sockets stay denied, and legacy port lists do not restrict servers",
  mac,
  async (t) => {
    const f = await fixture(t);
    const server = createHttpServer((_request, response) =>
      response.end("fixture"),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const command = f.code(
      `require('http').get('http://127.0.0.1:${port}',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(7));setTimeout(()=>process.exit(8),2000).unref()`,
    );
    assert.equal((await f.execute(command)).exitCode, 7);
    const outbound = { network: { outbound: true, localhostPorts: [] } };
    assert.equal((await f.execute(command, outbound)).exitCode, 0);
    const unix = createNetServer((socket) => socket.end("synthetic"));
    const socketPath = join(f.workspace, "control.sock");
    await new Promise((resolve) => unix.listen(socketPath, resolve));
    t.after(() => new Promise((resolve) => unix.close(resolve)));
    const result = await f.execute(
      f.code(
        `require('net').connect(${JSON.stringify(socketPath)}).on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))`,
      ),
      outbound,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const legacy = await f.execute("true", { network: { outbound: false, localhostPorts: [port] } });
    assert.equal(legacy.exitCode, 0);
    const inbound = await f.execute(
      f.code(
        "const s=require('net').createServer();s.on('error',()=>process.exit(0));s.listen(0,'127.0.0.1',()=>process.exit(1))",
      ),
      outbound,
    );
    assert.equal(inbound.exitCode, 1, inbound.stderr);
  },
);

test(
  "background receipts retain exact identity, read-only status and confirmed targeted stop",
  mac,
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.workspace, "background.cjs"),
      "setInterval(()=>{},1000);",
    );
    const launch = await f.launch("exec node background.cjs");
    assert.equal(launch.state, "running", JSON.stringify(launch));
    assert(launch.processEvidenceRef);
    const running = await inspect(f.controller, launch.processEvidenceRef);
    assert.equal(running.state, "running", JSON.stringify(running));
    assert.equal(running.processes.length, 1);
    assert(
      running.processes.every(
        (row) =>
          row.pid > 1 &&
          row.pgid > 1 &&
          row.start &&
          /^[a-f0-9]{64}$/.test(row.commandHash),
      ),
    );
    assert.deepEqual(running.listeningPorts, []);
    assert.equal(running.portsObserved, true);
    const directory = join(f.controller, "workspace-process-evidence");
    const original = JSON.parse(
      await readFile(
        join(directory, launch.processEvidenceRef.split(":")[1] + ".json"),
        "utf8",
      ),
    );
    for (const field of ["start", "pgid", "commandHash"]) {
      const evidence = structuredClone(original),
        ref = `workspace-process:${randomUUID()}`;
      evidence.ref = ref;
      for (const row of evidence.observed) {
        if (field === "start") row.start = "Mon Jan 1 01:00:00 2001";
        else if (field === "pgid") row.pgid++;
        else row.commandHash = "0".repeat(64);
      }
      const file = join(directory, ref.split(":")[1] + ".json");
      await writeFile(file, JSON.stringify(evidence), { mode: 0o600 });
      const before = await readFile(file, "utf8");
      const observed = await inspect(f.controller, ref);
      assert.equal(observed.state, "unknown");
      assert.deepEqual(observed.processes, []);
      assert.equal(await readFile(file, "utf8"), before);
      assert.equal(
        (await stop(f.controller, ref, { timeoutMs: 0 })).stopRequested,
        false,
      );
      assert.equal(
        (await inspect(f.controller, launch.processEvidenceRef)).state,
        "running",
      );
    }
    const missing = await inspect(
      f.controller,
      `workspace-process:${randomUUID()}`,
    );
    assert.equal(missing.state, "unknown");
    assert.equal(missing.processesSettled, false);
    const stopped = await stop(f.controller, launch.processEvidenceRef, {
      timeoutMs: 3000,
    });
    assert.equal(stopped.stopRequested, true);
    assert.equal(stopped.processesSettled, true);
    assert.equal(stopped.state, "exited");
  },
);

test(
  "unrestricted workspace ports run a real HTTP server and retain its actual listener and stop evidence",
  mac,
  async (t) => {
    const f = await fixture(t);
    const reservation = createNetServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const network = {
      outbound: false,
      localhostPorts: [],
      inboundPorts: [],
    };
    // This capability deliberately permits all interfaces. The test requests only
    // loopback, and status must report the real wildcard listener without renaming it.
    await writeFile(
      join(f.workspace, "http.cjs"),
      `require('http').createServer((_q,r)=>r.end('owned-server')).listen(${port},'0.0.0.0');`,
    );
    const launch = await f.launch("exec node http.cjs", { network });
    assert.equal(launch.mayHaveExecuted, true);
    assert(launch.processEvidenceRef);
    let status;
    for (let attempt = 0; attempt < 10; attempt++) {
      status = await inspect(f.controller, launch.processEvidenceRef);
      if (
        status.state === "running" &&
        status.listeningPorts.some((row) => row.port === port)
      )
        break;
      await delay(100);
    }
    assert.equal(status.state, "running", JSON.stringify(status));
    assert.equal(status.portsObserved, true);
    assert(
      status.listeningPorts.some(
        (row) => row.port === port && ["*", "0.0.0.0"].includes(row.address),
      ),
      JSON.stringify(status),
    );
    const response = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(await response.text(), "owned-server");
    const denied = await f.execute(
      f.code(
        "const s=require('net').createServer();s.on('error',()=>process.exit(0));s.listen(0,'127.0.0.1',()=>process.exit(1))",
      ),
      { network },
    );
    assert.equal(denied.exitCode, 1, denied.stderr);
    const stopped = await stop(f.controller, launch.processEvidenceRef, {
      timeoutMs: 3000,
    });
    assert.equal(stopped.stopRequested, true);
    assert.equal(stopped.state, "exited", JSON.stringify(stopped));
    assert.equal(stopped.processesSettled, true);
    assert.deepEqual(stopped.listeningPorts, []);
  },
);

test(
  "ignored TERM stays pending until actual exit; cancellation during preparation never dispatches",
  mac,
  async (t) => {
    const f = await fixture(t);
    const originalPrepare = WorkspaceProcessRecorder.prepare;
    try {
      for (const launch of [run, start]) {
        const controller = new AbortController();
        WorkspaceProcessRecorder.prepare = async (...args) => {
          const recorder = await originalPrepare.apply(
            WorkspaceProcessRecorder,
            args,
          );
          controller.abort();
          return recorder;
        };
        const result = await launch(f.policy, {
          command: "echo should-not-run",
          signal: controller.signal,
        });
        assert.equal(result.state, "not_started");
        assert.equal(result.mayHaveExecuted, false);
        assert.equal(result.processEvidenceRef, null);
      }
    } finally {
      WorkspaceProcessRecorder.prepare = originalPrepare;
    }
    await writeFile(
      join(f.workspace, "resistant.cjs"),
      "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1600);setInterval(()=>{},1000);",
    );
    const launched = await f.launch("exec node resistant.cjs");
    assert.equal(launched.state, "running");
    const pending = await stop(f.controller, launched.processEvidenceRef, {
      timeoutMs: 100,
    });
    assert.equal(pending.stopRequested, true);
    assert.equal(pending.processesSettled, false);
    assert.equal(pending.state, "running");
    await delay(1700);
    assert.equal(
      (await inspect(f.controller, launched.processEvidenceRef))
        .processesSettled,
      true,
    );
  },
);

test(
  "workspace Bash process substitution and inherited standard descriptors stay inside file policy",
  mac,
  async (t) => {
    const f = await fixture(t);
    const result = await f.execute(
      `/bin/bash -c ${quote('while IFS= read -r line; do printf "%s\\n" "$line"; done < <(printf "pipe-ok\\n"); printf "stdout-ok\\n" >/dev/stdout; printf "stderr-ok\\n" >/dev/stderr; printf "write-pipe-ok\\n" > >(cat); wait')}`,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "pipe-ok\nstdout-ok\nwrite-pipe-ok\n");
    assert.equal(result.stderr, "stderr-ok\n");
    assert.equal(result.processesSettled, true);
    const protectedFile = join(f.controller, "fd-protected-canary");
    await writeFile(protectedFile, "synthetic-still-protected");
    const denied = await f.execute(
      `/bin/bash -c ${quote(`/bin/cat ${quote(protectedFile)} >/dev/stdout`)}`,
    );
    assert.notEqual(denied.exitCode, 0);
    assert(!denied.stdout.includes("synthetic-still-protected"));
  },
);

test(
  "approved outbound workspace resolves DNS and reaches the public npm HTTPS registry",
  {
    ...mac,
    skip:
      process.platform !== "darwin" ||
      process.env.CREW_TEST_PUBLIC_REGISTRY !== "1",
  },
  async (t) => {
    const f = await fixture(t);
    const command = f.code(`
      require('node:dns').lookup('registry.npmjs.org', { all: true }, (error, addresses) => {
        if (error) { console.log(JSON.stringify({stage:'dns',code:error.code})); process.exitCode=1; return; }
        const request=require('node:https').get('https://registry.npmjs.org/-/ping', response => {
          let bytes=0;
          response.on('data', chunk => { bytes+=chunk.length; if(bytes>4096) request.destroy(new Error('response_limit')); });
          response.on('end', () => { console.log(JSON.stringify({stage:'https',dnsAddressCount:addresses.length,status:response.statusCode})); if(response.statusCode!==200)process.exitCode=1; });
        });
        request.setTimeout(5000,()=>request.destroy(new Error('request_timeout')));
        request.on('error', error=>{console.log(JSON.stringify({stage:'https',code:error.code??'request_failed'}));process.exitCode=1;});
      });
    `);
    const result = await f.execute(command, {
      network: { outbound: true, localhostPorts: [] },
    });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.stage, "https");
    assert(observed.dnsAddressCount > 0);
    assert.equal(observed.status, 200);
    assert.equal(result.processesSettled, true);
  },
);
