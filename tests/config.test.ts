import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/server/config.js";

test("Ping OTP configuration requires a token and destination together", () => {
  assert.throws(() => loadConfig({ COMOTE_PING_WEBHOOK_TOKEN: "secret" }), /configured together/);
  assert.throws(() => loadConfig({ COMOTE_OTP_EMAIL: "bob@example.com" }), /configured together/);
});

test("Ping OTP configuration accepts only a valid email and HTTPS webhook", () => {
  assert.throws(() => loadConfig({
    COMOTE_PING_WEBHOOK_TOKEN: "secret",
    COMOTE_OTP_EMAIL: "not-an-email",
  }), /valid email/);
  assert.throws(() => loadConfig({
    COMOTE_PING_WEBHOOK_TOKEN: "secret",
    COMOTE_OTP_EMAIL: "bob@example.com",
    COMOTE_PING_WEBHOOK_URL: "http://chat.example/notify",
  }), /must use HTTPS/);

  const config = loadConfig({
    COMOTE_PING_WEBHOOK_TOKEN: "secret",
    COMOTE_OTP_EMAIL: "Bob@Example.com",
  });
  assert.equal(config.otpEmail, "bob@example.com");
  assert.equal(config.pingWebhookUrl, "https://chat.devop.my.id/api/webhook/notify");
});
