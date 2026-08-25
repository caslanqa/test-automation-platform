#!/usr/bin/env node
/**
 * `tms` entry point. A thin wrapper so the CLI itself stays a pure function of argv and a project
 * directory, which is what makes it testable without spawning anything.
 */
import { run } from '../dist/cli/index.js';

process.exit(await run(process.argv.slice(2)));
