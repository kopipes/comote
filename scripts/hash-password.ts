import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../src/server/password.js";

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question("Comote password (minimum 12 characters): ");
rl.close();

try {
  console.log(await hashPassword(password));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
