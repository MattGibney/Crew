import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Drive the real editor state and event handlers with deterministic hook cells.
// UI primitives are passive elements; no DOM, polling, network or native effects run.
const hooks = `let cells=[],cursor=0;
export function reset(){cells=[];cursor=0;}
export function begin(){cursor=0;}
export function useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;}];}
export function useRef(initial){const i=cursor++;return cells[i]??(cells[i]={current:initial});}
export function useEffect(){cursor++;}`;
const built = await build({
  stdin: {
    contents:
      'export {ManagerSchedules} from "./settings/ManagerSchedules.tsx";export {reset,begin} from "react";',
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  tsconfig: fileURLToPath(
    new URL("../../../tsconfig.renderer.json", import.meta.url),
  ),
  plugins: [
    {
      name: "deterministic-editor",
      setup(builder) {
        builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({
          path: args.path,
          namespace: "editor-hooks",
        }));
        builder.onLoad({ filter: /.*/, namespace: "editor-hooks" }, (args) => ({
          contents:
            args.path === "react"
              ? hooks
              : 'export const Fragment=Symbol.for("test.fragment");export const jsx=(type,props)=>({type,props});export const jsxs=jsx;',
          loader: "js",
        }));
        builder.onResolve({ filter: /^@\/components\/ui\// }, (args) => ({
          path: args.path,
          namespace: "editor-ui",
        }));
        builder.onLoad({ filter: /.*/, namespace: "editor-ui" }, () => ({
          contents:
            'export const Button="button",Input="input",Label="label",Textarea="textarea";',
          loader: "js",
        }));
      },
    },
  ],
});
const { ManagerSchedules, reset, begin } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object"
    ? text(tree.props?.children)
    : String(tree ?? "");
}
function harness() {
  reset();
  const notices = [],
    requests = [],
    pending = [];
  const manager = {
    settings: {
      managerSchedules: {
        revision: "revision-one",
        schedules: [
          {
            id: "one",
            name: "Initial name",
            instruction: "Initial instruction",
            enabled: false,
            timing: { kind: "interval", minutes: 10 },
          },
        ],
      },
    },
    loadSettings: async () => {},
    saveManagerSchedules: async (schedules, revision) => {
      const job = deferred();
      requests.push({ schedules: structuredClone(schedules), revision });
      pending.push(job);
      return job.promise;
    },
  };
  const render = () => {
    begin();
    return ManagerSchedules({
      manager,
      onNotify: (message) => notices.push(message),
      visible: false,
    });
  };
  const button = (label) => {
    const node = nodes(render()).find(
      (node) => node.type === "button" && text(node) === label,
    );
    assert.ok(node, `Missing button ${label}`);
    return node;
  };
  const input = (id) => {
    const node = nodes(render()).find((node) => node.props?.id === id);
    assert.ok(node, `Missing input ${id}`);
    return node;
  };
  const confirm = (index, revision) => {
    manager.settings.managerSchedules = {
      revision,
      schedules: requests[index].schedules,
    };
    pending[index].resolve({
      managerSchedules: manager.settings.managerSchedules,
    });
  };
  return {
    manager,
    render,
    button,
    input,
    confirm,
    notices,
    requests,
    pending,
  };
}

test("schedule edits made during Save survive the response and use its confirmed revision on the next Save", async () => {
  const h = harness();
  h.button("Edit").props.onClick();
  h.input("name-one").props.onChange({ target: { value: "Submitted name" } });
  h.button("Save schedules").props.onClick();
  assert.equal(h.requests[0].revision, "revision-one");
  assert.equal(h.button("Saving…").props.disabled, true);
  h.input("name-one").props.onChange({
    target: { value: "Newer unsaved name" },
  });
  h.input("instruction-one").props.onChange({
    target: { value: "Newer unsaved instruction" },
  });
  h.render();
  h.confirm(0, "revision-two");
  await flush();
  assert.equal(h.input("name-one").props.value, "Newer unsaved name");
  assert.equal(
    h.input("instruction-one").props.value,
    "Newer unsaved instruction",
  );
  assert.equal(h.button("Save schedules").props.disabled, false);
  assert.equal(
    h.notices.at(-1),
    "Manager schedules saved. Your newer edits are still unsaved.",
  );
  h.button("Save schedules").props.onClick();
  assert.equal(h.requests[1].revision, "revision-two");
  assert.equal(h.requests[1].schedules[0].name, "Newer unsaved name");
  assert.equal(
    h.requests[1].schedules[0].instruction,
    "Newer unsaved instruction",
  );
  h.render();
  h.confirm(1, "revision-three");
  await flush();
  assert.equal(h.button("Save schedules").props.disabled, true);
  assert.equal(h.notices.at(-1), "Manager schedules saved.");
});

test("a failed schedule save keeps newer edits and the original revision for an explicit retry", async () => {
  const h = harness();
  h.button("Edit").props.onClick();
  h.input("instruction-one").props.onChange({
    target: { value: "Submitted instruction" },
  });
  h.button("Save schedules").props.onClick();
  h.input("instruction-one").props.onChange({
    target: { value: "Keep this newer instruction" },
  });
  h.render();
  h.pending[0].reject(Error("Synthetic save failure"));
  await flush();
  assert.equal(
    h.input("instruction-one").props.value,
    "Keep this newer instruction",
  );
  assert.match(text(h.render()), /Synthetic save failure/);
  assert.equal(h.notices.length, 0);
  h.button("Save schedules").props.onClick();
  assert.equal(h.requests[1].revision, "revision-one");
  assert.equal(
    h.requests[1].schedules[0].instruction,
    "Keep this newer instruction",
  );
  h.render();
  h.confirm(1, "revision-two");
  await flush();
});
