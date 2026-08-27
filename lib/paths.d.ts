/**
 * Resolve Maestro Harness root without hardcoding a machine-specific home path.
 * Priority: env > walk up from current file > cwd check > homedir fallback (last resort).
 */
export declare function resolveHarnessRoot(): string;
export declare function resolveDeepseekHarnessDir(): string;
