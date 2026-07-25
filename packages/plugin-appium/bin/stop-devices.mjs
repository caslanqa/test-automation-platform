#!/usr/bin/env node

import { stopBootedDevices } from '../dist/index.js';

await stopBootedDevices();
console.log('✔ [appium] stopped auto-booted devices (set APPIUM_KEEP_DEVICES=1 to keep them)');
