export interface NotifierOpts {
    send?: (msg: string) => Promise<void>;
}
export declare function notifyAutoRestart(reason: string, opts?: NotifierOpts & {
    httpCode?: string | number;
    lkgId?: string;
    reportPath?: string;
}): Promise<void>;
export declare function notify(msg: string, opts?: NotifierOpts): Promise<void>;
export declare function notifyCrash(reportPath: string, error: string, opts?: NotifierOpts): Promise<void>;
export declare function notifyDegraded(id: string, error: string, opts?: NotifierOpts): Promise<void>;
export declare function notifyFixed(branch: string, sessions: string[], opts?: NotifierOpts): Promise<void>;
