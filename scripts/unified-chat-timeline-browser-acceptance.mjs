// #123: real AgentsApp and timeline projection, disposable synthetic ports only.
// npm run build first. No native model, owner profile, audio, microphone or installation.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { projectCodexItem } from "../runtime/agents/codex-history.mjs";
import { VoiceTranscriptArtifacts } from "../runtime/agents/voice-artifacts.mjs";
const { chromium } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const root = process.cwd(),
  output = await realpath(await mkdtemp(path.join(tmpdir(), "crew-timeline-123-")));
const binding = {
  projectId: "fixture",
  agentId: "manager",
  threadId: "thread",
  sessionId: "session",
};
const turnTime = 1792756800;
const projected = projectCodexItem(
  binding,
  { id: "native", type: "agentMessage", text: "native" },
  "turn",
  undefined,
  turnTime,
);
assert.equal(
  projected.timestamp,
  new Date(turnTime * 1000).toISOString(),
  "Native protocol seconds remain actual timestamps",
);
assert.equal(projected.timestampSource, "native_turn");
assert.equal(
  projectCodexItem(
    binding,
    { id: "old", type: "agentMessage", text: "old" },
    "turn",
  ).timestamp,
  undefined,
);
// Genuine artifact storage verifies queued deltas and completion do not move time.
const artifactOptions = {
  directory: path.join(output, "artifact-store"),
  projectId: "fixture",
  ownerUserId: "owner",
};
let store = await VoiceTranscriptArtifacts.open(artifactOptions);
const record = {
  binding,
  callId: "storage-call",
  voiceSessionId: "voice",
  realtimeSessionId: "realtime",
  itemId: "storage-item",
  role: "assistant",
  text: "First",
  done: false,
  delta: false,
  observedAt: "2026-10-23T12:00:00.000Z",
};
await Promise.all([
  store.record(record),
  store.record({
    ...record,
    text: " words",
    delta: true,
    observedAt: "2026-10-23T12:00:01.000Z",
  }),
  store.record({
    ...record,
    text: "First words",
    done: true,
    observedAt: "2026-10-23T12:00:02.000Z",
  }),
]);
await store.closeCall(binding, "storage-call");
await store.dispose();
store = await VoiceTranscriptArtifacts.open(artifactOptions);
const stored = (await store.list(binding.agentId, binding.threadId))
  .artifacts[0].items[0];
assert.equal(stored.observedAt, record.observedAt);
assert.equal(stored.text, "First words");
assert.equal(stored.done, true);
await store.dispose();
console.log(
  "PASS genuine artifact queue and reopen preserve first observation and completed text",
);
const entry = path.join(output, "fixture.tsx");
await writeFile(
  entry,
  `
import React, {useEffect, useState} from ${JSON.stringify(path.join(root, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(path.join(root, "node_modules/react-dom/client.js"))};
import {AgentsApp} from ${JSON.stringify(path.join(root, "renderer/src/agents/AgentsApp.tsx"))};
import {updateLiveTranscript} from ${JSON.stringify(path.join(root, "renderer/src/agents/voice/live-transcript.ts"))};
const now='2026-10-23T12:00:00.000Z';
const agent={id:'manager',projectId:'fixture',createdAt:now,updatedAt:now,archivedAt:null,profile:{revision:1,name:'Alex',pictureRef:null,personality:'',systemPrompt:''},skills:[],access:{permissionGroupIds:[],serviceConnectionIds:[],inheritPersonalServiceCredentials:false},runtime:{provider:'codex',modelAccessId:'fixture',configRef:'fixture',threadId:'thread',session:{sessionId:'session',desiredState:'started',observedState:'started',activeTurnId:null,startedAt:now,lastObservedAt:now,lastError:null,appliedConfiguration:null}},scratchpad:{markdown:'',revision:1,updatedAt:now},reportsTo:{type:'user',userId:'owner'},resources:[]};
let snapshot={projectId:'fixture',projectName:'Timeline fixture',ownerId:'owner',primaryAgentId:'manager',voiceArtifactsRevision:1,agents:[agent],jobs:[],skills:[],pendingMessages:[],receipts:[],helpRequests:[],ownerInbox:[],nativeApprovals:[],readiness:[]};
let native=[], artifacts=[], live=[], failure=false, delay=0, cursor=null, older=[];
const listeners=new Set(), voices=new Set();
window.fixture={calls:[],media:0,update(change){
 if(change.native)native=change.native;if(change.artifacts)artifacts=change.artifacts;if('live' in change){live=change.live;for(const cb of voices)cb([...live]);}
 if(change.transcript){live=updateLiveTranscript(live,change.transcript);for(const cb of voices)cb([...live]);}
 if('failure'in change)failure=change.failure;if('delay'in change)delay=change.delay;if('cursor'in change)cursor=change.cursor;if(change.older)older=change.older;
 snapshot={...snapshot,voiceArtifactsRevision:snapshot.voiceArtifactsRevision+1};for(const cb of listeners)cb({kind:'runtime',event:{kind:'history',binding:{agentId:'manager'}}});
}};
navigator.mediaDevices.getUserMedia=async()=>{window.fixture.media++;throw Error('Physical media forbidden');};
const client={readSnapshot:async()=>snapshot,subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},readHistory:async()=>({state:'acknowledged',value:{items:native,nextCursor:null}}),readVoiceArtifacts:async(_id,page)=>{await new Promise(r=>setTimeout(r,delay));return failure?{state:'failed',error:{message:'Fixture transcript storage unavailable'}}:{state:'acknowledged',value:{artifacts:page?older:artifacts,nextCursor:page?null:cursor,warning:null}}},sendMessage:async input=>{window.fixture.calls.push(input);const timestamp='2026-10-23T12:40:00.000Z';native=[...native,{runtimeRef:'sent',turnId:'sent-turn',kind:'message',sender:{type:'user',userId:'owner'},content:input.content,metadata:{},timestamp}];return{state:'acknowledged',value:null}}};
function Voice({onTranscript}){const [items,setItems]=useState(live);useEffect(()=>{voices.add(setItems);return()=>voices.delete(setItems)},[]);useEffect(()=>{onTranscript(items)},[items,onTranscript]);return null;}
createRoot(document.getElementById('root')).render(<AgentsApp client={client} renderVoice={context=><Voice onTranscript={context.onTranscript}/>}/>);
`,
);
await build({
  entryPoints: [entry],
  outfile: path.join(output, "fixture.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  alias: { "@": path.join(root, "renderer/src") },
  loader: { ".css": "empty", ".png": "dataurl" },
  nodePaths: [path.join(root, "node_modules")],
});
const cssNames = (
  await readdir(path.join(root, "renderer-dist/assets"))
).filter((name) => name.endsWith(".css"));
const css = (
  await Promise.all(
    cssNames.map((name) =>
      readFile(path.join(root, "renderer-dist/assets", name), "utf8"),
    ),
  )
).join("\n");
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const server = http.createServer(async (req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/styles.css"
      ? "text/css"
      : req.url === "/fixture.js"
        ? "text/javascript"
        : "text/html",
  );
  res.end(
    req.url === "/styles.css"
      ? css
      : req.url === "/fixture.js"
        ? await readFile(path.join(output, "fixture.js"))
        : html,
  );
});
let browser;
const passed = [];
const check = (name, value) => {
  assert.ok(value, name);
  passed.push(name);
  console.log("PASS", name);
};
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  const update = (change) =>
    page.evaluate((change) => window.fixture.update(change), change);
  const native = (id, minute, text = id) => ({
    runtimeRef: id,
    turnId: id,
    kind: "message",
    sender: { type: "user", userId: "owner" },
    content: [{ type: "text", text }],
    metadata: {},
    timestamp: "2026-10-23T12:" + minute + ":00.000Z",
  });
  const artifact = (
    state = "closed",
    items = [
      {
        itemId: "speech",
        role: "assistant",
        text: "Voice between typed messages",
        done: true,
        ordinal: 0,
        observedAt: "2026-10-23T12:01:00.000Z",
      },
    ],
  ) => ({
    id: "artifact",
    projectId: "fixture",
    agentId: "manager",
    threadId: "thread",
    callId: "call",
    voiceSessionId: "voice",
    realtimeSessionId: "realtime",
    createdAt: "2026-10-23T12:01:00.000Z",
    updatedAt: "2026-10-23T12:01:30.000Z",
    state,
    items,
  });
  const ids = () =>
    page
      .locator("article[data-message-id]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
  const settle = () => page.waitForTimeout(450);
  await update({
    native: [
      native("typed-before", "00"),
      native("typed-after", "02"),
      { ...native("hidden", "03"), sender: { type: "system" }, kind: "other" },
    ],
    artifacts: [artifact()],
  });
  await settle();
  check(
    "interleaved typed and retained voice are chronological",
    (await ids()).join("|") ===
      'typed-before|voice:["thread","call","speech"]|typed-after',
  );
  check(
    "normal messages have no saved/historical/voice section labels",
    !/Saved voice calls|saved voice|historical|Recent live call transcript/i.test(
      await page.locator('[aria-label="Conversation messages"]').innerText(),
    ),
  );
  // Use the actual composer label independently of the profile-specific wording.
  const composer = page.locator("textarea").first();
  await composer.fill("Keep my unsent draft");
  const transcript = {
    kind: "transcript",
    binding,
    callId: "call2",
    itemId: "live-item",
    role: "assistant",
    text: "Live words",
    done: false,
    delta: false,
    observedAt: "2026-10-23T12:03:00.000Z",
  };
  await update({ transcript });
  await settle();
  check(
    "live transcript appends at bottom",
    (await ids()).at(-1) === 'voice:["thread","call2","live-item"]',
  );
  const liveId = (await ids()).at(-1),
    node = await page.locator("article").last().elementHandle();
  await update({
    transcript: { ...transcript, text: "Live words complete", done: true },
  });
  await settle();
  const retained = {
    ...artifact(),
    id: "artifact2",
    callId: "call2",
    items: [
      {
        itemId: "live-item",
        role: "assistant",
        text: "Live words complete",
        done: true,
        ordinal: 0,
        observedAt: transcript.observedAt,
      },
    ],
  };
  await update({ delay: 800, live: [], artifacts: [artifact(), retained] });
  await page.waitForTimeout(250);
  check(
    "hangup keeps last live snapshot while retention loads",
    (await ids()).includes(liveId),
  );
  await page.waitForTimeout(1000);
  check(
    "live-to-retained identity has exactly one bubble",
    (await ids()).filter((id) => id === liveId).length === 1,
  );
  check(
    "live-to-retained keeps the DOM node",
    await node.evaluate(
      (el) =>
        el ===
        document.querySelectorAll("article")[
          document.querySelectorAll("article").length - 1
        ],
    ),
  );
  check(
    "async refresh preserves composer draft",
    (await composer.inputValue()) === "Keep my unsent draft",
  );
  await update({ delay: 0, failure: true });
  await settle();
  check(
    "failed refresh keeps loaded messages and reports stale",
    /may be stale/.test(
      await page.locator('[aria-label="Conversation messages"]').innerText(),
    ),
  );
  await update({ failure: false });
  await settle();
  await page.screenshot({ path: path.join(output, "timeline-desktop.png") });
  // Reload restoration reads the fixture ports again with the same canonical identities.
  const restoration = {
    native: [native("typed-before", "00"), native("typed-after", "02")],
    artifacts: [artifact(), retained],
  };
  await page.reload();
  await page.waitForFunction(() => Boolean(window.fixture));
  await update(restoration);
  await settle();
  check(
    "reload restores one chronological timeline",
    (await ids()).join("|") ===
      'typed-before|voice:["thread","call","speech"]|typed-after|voice:["thread","call2","live-item"]',
  );
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  check(
    "reload restores draft",
    (await composer.inputValue()) === "Keep my unsent draft",
  );
  const tie = native("tie", "01");
  await update({
    ...restoration,
    native: [restoration.native[0], tie, restoration.native[1]],
  });
  await settle();
  const tied = await ids();
  await update({
    ...restoration,
    native: [restoration.native[0], tie, restoration.native[1]],
  });
  await settle();
  check(
    "equal timestamps keep stable ordering",
    JSON.stringify(await ids()) === JSON.stringify(tied),
  );
  const undated = { ...native("undated", "00") };
  delete undated.timestamp;
  await update({ native: [undated, ...restoration.native] });
  await settle();
  check(
    "missing native times are disclosed",
    /order relative to voice messages cannot be verified/.test(
      await page.locator('[aria-label="Conversation messages"]').innerText(),
    ),
  );
  const messages = Array.from({ length: 35 }, (_, i) => ({
    ...native("long-" + i, String(i).padStart(2, "0")),
    content: [
      {
        type: "text",
        text: "Message " + i + "\n\n" + "Reading paragraph. ".repeat(60),
      },
    ],
  }));
  await update({ native: messages, artifacts: [], live: [] });
  await settle();
  const viewport = page
    .locator('[data-slot="message-scroller-viewport"]')
    .first();
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await settle();
  const metrics = () =>
    viewport.evaluate((el) => ({
      top: el.scrollTop,
      bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
  await update({ native: [...messages, native("new-bottom", "36")] });
  await settle();
  check(
    "new messages follow bottom when reading latest",
    (await metrics()).bottom < 8,
  );
  await viewport.hover();
  await page.mouse.wheel(0, -2200);
  await settle();
  const reading = await metrics();
  await update({
    native: [
      ...messages,
      native("new-bottom", "36"),
      native("another-bottom", "37"),
    ],
  });
  await settle();
  check(
    "new messages preserve earlier reading position",
    Math.abs((await metrics()).top - reading.top) < 5,
  );
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await settle();
  check("jump to latest resumes bottom", (await metrics()).bottom < 8);
  await update({
    native: restoration.native,
    artifacts: [artifact()],
    cursor: "older",
    older: [
      {
        ...artifact(),
        id: "older",
        callId: "older",
        items: [
          {
            itemId: "old",
            role: "user",
            text: "Earlier voice",
            done: true,
            ordinal: 0,
            observedAt: "2026-10-23T11:00:00.000Z",
          },
        ],
      },
    ],
  });
  await settle();
  await page
    .getByRole("button", { name: "Load earlier voice messages" })
    .click();
  await settle();
  check(
    "older voice pages enter chronological position",
    (await ids())[0] === 'voice:["thread","older","old"]',
  );
  await page.setViewportSize({ width: 480, height: 800 });
  await settle();
  await page.screenshot({ path: path.join(output, "timeline-mobile.png") });
  check(
    "narrow layout has no horizontal overflow",
    await viewport.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  check(
    "no microphone calls or implicit dispatch",
    await page.evaluate(
      () => window.fixture.media === 0 && window.fixture.calls.length === 0,
    ),
  );
  await composer.fill("A new typed message after voice");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await settle();
  check(
    "explicit typed send appends after voice",
    (await ids()).at(-1) === "sent",
  );
  check(
    "only explicit send dispatches once",
    await page.evaluate(
      () =>
        window.fixture.calls.length === 1 &&
        window.fixture.calls[0].content[0].text ===
          "A new typed message after voice",
    ),
  );
  check("no browser errors", errors.length === 0);
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify({ passed, errors }, null, 2),
  );
  console.log("Evidence:", output);
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
