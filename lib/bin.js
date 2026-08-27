#!/usr/bin/env node
import { runCli } from './cli.js';
runCli(process.argv).catch(e => { console.error(e); process.exit(1); });
