// node --test setup: load the Rust core from disk (the Workers import it as a wasm module).
import { readFileSync } from "node:fs";
import { initCore } from "../src/alfred/core.ts";
initCore(new WebAssembly.Module(readFileSync(new URL("../src/alfred/wasm/alfred_core.wasm", import.meta.url))));
