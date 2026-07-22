#!/usr/bin/env node
// Shut down the emulators/simulators the framework auto-booted this run. Imports the compiled
// teardown directly (not the package root) so it stays lightweight — no Playwright load.
import { stopBootedDevices } from '../dist/teardown.js';

await stopBootedDevices();
console.log('✔ [maestro] stopped auto-booted devices (set MOBILE_KEEP_DEVICES=1 to keep them)');
