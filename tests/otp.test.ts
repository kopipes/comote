import assert from "node:assert/strict";
import test from "node:test";
import { OtpStore } from "../src/server/otp.js";

test("OTP is six-digit, single-use, and bound to the requesting client", () => {
  let now = 1_000_000;
  const store = new OtpStore(() => now, () => "123456");
  const challenge = store.create("100.64.0.1", "My Phone");
  assert.equal(challenge.code, "123456");
  assert.equal(challenge.resendAfterSeconds, 60);
  assert.throws(() => store.verify(challenge.challengeId, "123456", "100.64.0.2"), /invalid or expired/);
  assert.deepEqual(store.verify(challenge.challengeId, "123456", "100.64.0.1"), { deviceName: "My Phone" });
  assert.throws(() => store.verify(challenge.challengeId, "123456", "100.64.0.1"), /invalid or expired/);
  now += 1;
});

test("OTP expires, limits guesses, and enforces resend cooldown", () => {
  let now = 2_000_000;
  const store = new OtpStore(() => now, () => "654321");
  const first = store.create("100.64.0.1", "Laptop");
  assert.throws(() => store.create("100.64.0.1", "Laptop"), /Wait before requesting/);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => store.verify(first.challengeId, "000000", "100.64.0.1"), /invalid or expired/);
  }
  assert.throws(() => store.verify(first.challengeId, "654321", "100.64.0.1"), /invalid or expired/);

  now += 61_000;
  const expiring = store.create("100.64.0.1", "Laptop");
  now += 5 * 60_000;
  assert.throws(() => store.verify(expiring.challengeId, "654321", "100.64.0.1"), /invalid or expired/);
});
