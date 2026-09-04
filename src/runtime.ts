import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeStdio,
  NodeTerminal,
} from "@effect/platform-node-shared";
import { Layer, ManagedRuntime } from "effect";

import { CommandRunner } from "./services/command-runner";

const NodeCliLayer = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer, NodeTerminal.layer),
);

export const ApplicationLayer = Layer.merge(NodeCliLayer, CommandRunner.layer);

export const applicationRuntime = ManagedRuntime.make(ApplicationLayer);
