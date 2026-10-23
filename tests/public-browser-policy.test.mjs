import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicAddress,
  parsePublicBrowserURL,
  requirePublicResolution,
} from "../src/browser/public-origin.mts";

test("public browser rejects private/reserved and disguised IP destinations", async () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.2",
    "169.254.169.254",
    "172.31.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const url of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:127.0.0.1]/",
    "http://127.0.0.1:4050/",
    "file:///etc/passwd",
    "chrome://settings",
    "https://user:pass@example.com/",
  ])
    assert.throws(() => parsePublicBrowserURL(url, "http://127.0.0.1:4050"));
  for (const address of ["1.1.1.1", "93.184.215.14", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true);
  assert.equal(
    parsePublicBrowserURL("https://example.com/").protocol,
    "https:",
  );
  await assert.rejects(
    requirePublicResolution("example.com", async () => ({
      endpoints: [{ address: "1.1.1.1" }, { address: "127.0.0.1" }],
    })),
  );
  await assert.rejects(
    requirePublicResolution("example.com", async () => ({ endpoints: [] })),
  );
  await requirePublicResolution("example.com", async () => ({
    endpoints: [{ address: "1.1.1.1" }],
  }));
});
