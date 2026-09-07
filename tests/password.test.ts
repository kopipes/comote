import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, PasswordStore, verifyPassword } from "../src/server/password.js";

test("password hashes verify without storing the password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong password", encoded), false);
});

test("short passwords are rejected", async () => {
  await assert.rejects(() => hashPassword("too-short"), /at least 12/);
});

test("password changes persist without editing the root-owned environment", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "comote-password-"));
  const initialHash = await hashPassword("initial-password-123");
  const store = new PasswordStore(dataDir, initialHash);
  await store.init();
  assert.equal(await store.verify("initial-password-123"), true);
  await store.change("initial-password-123", "replacement-password-456");
  assert.equal(await store.verify("initial-password-123"), false);
  assert.equal(await store.verify("replacement-password-456"), true);

  const reloaded = new PasswordStore(dataDir, initialHash);
  await reloaded.init();
  assert.equal(await reloaded.verify("replacement-password-456"), true);
  await assert.rejects(() => reloaded.change("wrong-password", "another-password-789"), /incorrect/);
});
