/**
 * NeuroTrace runtime constants for the local-first open-source build.
 */

export const NEUROTRACE_CONFIG = {
    UNLIMITED_MEMORIES: true,
    UI_UPDATE_INTERVAL_MS: 3600000
} as const;

export function getUIUpdateInterval(): number {
    return NEUROTRACE_CONFIG.UI_UPDATE_INTERVAL_MS;
}
