import { Writable } from "node:stream";

const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export type ExecutionSettings = {
  json: boolean;
  output: Writable;
  useDefaults: boolean;
};

/** Resolves the shared interaction policy for human and machine-readable modes. */
export function resolveExecutionSettings(options: {
  json?: boolean;
  yes?: boolean;
}): ExecutionSettings {
  const json = options.json === true;
  return {
    json,
    output: json ? silentOutput : process.stdout,
    useDefaults: options.yes === true || json,
  };
}
