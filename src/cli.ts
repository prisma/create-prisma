import { NodeRuntime } from "@effect/platform-node-shared";
import { Effect } from "effect";

import { runCreatePrismaCli } from "./index";
import { ApplicationLayer } from "./runtime";

runCreatePrismaCli().pipe(
  Effect.provide(ApplicationLayer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
