import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/server/password.js";

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
