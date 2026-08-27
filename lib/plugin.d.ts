/**
 * dsh-maestro-supervisor — host plugin for auto-resume inside DSH web.
 * Runs inside the DSH host process (outside the daemon's tree) and
 * auto-resumes sessions interrupted within the configured window after
 * a restart. The standalone daemon (systemd) handles crash detection
 * and web restart; this plugin handles the in-process resume.
 */
export declare const inject: readonly ["sessions", "connection"];
export interface SupervisorPluginConfig {
    autoResumeWithin?: number | string;
    autoResumeEnabled?: boolean;
}
export declare function apply(ctx: any, _config?: SupervisorPluginConfig): void;
