/**
 * dsh-maestro-supervisor — Cordis host plugin entry.
 * The daemon CLI lives in bin.ts (lib/bin.js); this file is the
 * host plugin loaded by DSH web via cordis.patch.yml.
 */
export * from './plugin.js'
export { apply, inject } from './plugin.js'
