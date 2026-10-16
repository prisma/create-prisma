import { NodeRuntime } from "@effect/platform-node-shared";
import { Effect } from "effect";
import { spawn } from "node:child_process";

import { runCreatePrismaCli } from "./index";
import { ApplicationLayer } from "./runtime";
import { shouldRelaunchOnBun } from "./utils/node-version";

function relaunchOnBun(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("bun", process.argv.slice(1), { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  });
}

if (!(shouldRelaunchOnBun() && (await relaunchOnBun()))) {
  runCreatePrismaCli().pipe(
    Effect.provide(ApplicationLayer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
