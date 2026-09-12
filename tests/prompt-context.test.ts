import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexInput, safeDeploymentNote, stripComoteContext } from "../src/server/prompt-context.js";

test("Codex input carries private notes, verified attachment paths, and the safe deploy rule", () => {
  const input = buildCodexInput("Please fix this layout", "Use Indonesian copy.", [{
    id: "4d5bfbe0-f495-4fa0-8302-a154aec76b03",
    name: "screen.png",
    size: 10,
    path: "/private/comote/screen.png",
  }]);
  assert.match(input, /Attached: screen\.png/);
  assert.match(input, /Use Indonesian copy/);
  assert.match(input, /\/private\/comote\/screen\.png/);
  assert.ok(input.includes(safeDeploymentNote));
  assert.equal(stripComoteContext(input), "Please fix this layout\n\nAttached: screen.png");
});

test("safe deployment context is present even without custom notes or files", () => {
  const input = buildCodexInput("Deploy this app", "", []);
  assert.match(input, /read-only inventory/);
  assert.equal(stripComoteContext(input), "Deploy this app");
});

