#!/usr/bin/node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const slug = process.argv[2] ?? "";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 24) {
  console.error("Invalid Comote application name.");
  process.exit(64);
}

let command;
try {
  command = JSON.parse(await readFile(`/etc/comote/apps/${slug}.command.json`, "utf8"));
} catch (error) {
  console.error(`Cannot read application command: ${error.message}`);
  process.exit(78);
}
if (!Array.isArray(command) || command.length < 1 || command.some((item) => typeof item !== "string" || !item)) {
  console.error("Application command is invalid.");
  process.exit(78);
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env });
child.on("error", (error) => {
  console.error(`Cannot start application: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
