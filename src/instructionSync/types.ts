export type BuiltInInstructionTargetId = 'agents' | 'claude' | 'copilot' | 'cursor';

export type InstructionTargetStatus = 'create' | 'update' | 'unchanged' | 'error' | 'disabled';

export type InstructionSeedSource = 'workspace-agents' | 'neurotrace-scaffold' | 'custom-import';

export interface InstructionTargetConfig {
    id: string;
    label: string;
    relativePath: string;
    enabled: boolean;
    targetType: BuiltInInstructionTargetId | 'custom';
    userAdded?: boolean;
}

export interface InstructionSyncConfig {
    version: 1;
    canonicalPath: string;
    seedSource: InstructionSeedSource;
    sourceLabel?: string;
    targets: InstructionTargetConfig[];
}

export interface InstructionTargetPreview {
    id: string;
    label: string;
    relativePath: string;
    targetType: BuiltInInstructionTargetId | 'custom';
    enabled: boolean;
    status: InstructionTargetStatus;
    message: string;
}

export interface InstructionSyncPanelState {
    canonicalPath: string;
    canonicalContent: string;
    seedSourceLabel: string;
    targets: InstructionTargetPreview[];
}
