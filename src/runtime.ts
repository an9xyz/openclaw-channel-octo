import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setOctoRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getOctoRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Octo runtime not initialized");
  }
  return runtime;
}
