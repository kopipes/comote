import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme } from "../src/client/theme.js";

test("explicit themes override the operating-system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("system theme follows the operating-system preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});
