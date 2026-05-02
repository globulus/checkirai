#!/usr/bin/env node
import { main } from "./index.js";

// Executable entrypoint for the published CLI.
// The actual command surface lives in `index.ts` so it can be reused by tests/tools.
void main(process.argv);
