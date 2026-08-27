interface ManifestEntry {
    path: string;
    sha256: string;
}
interface Manifest {
    ts: string;
    files: ManifestEntry[];
}
export declare function writeLKG(dshHome: string, lkgRoot: string): Promise<{
    ts: string;
    manifest: Manifest;
}>;
export declare function verifyLKG(lkgPath: string): Promise<boolean>;
export declare function rotateLKG(lkgRoot: string, keep?: number): Promise<void>;
export declare function writeFailed(dshHome: string, failedRoot: string): Promise<{
    ts: string;
    manifest: Manifest;
}>;
export {};
