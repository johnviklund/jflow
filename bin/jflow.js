#!/usr/bin/env node
// The jflow helper. Build first: `npm run build` (emits dist/ from src/).
import { main } from "../dist/cli.js";

await main();
