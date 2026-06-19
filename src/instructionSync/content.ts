import * as path from 'path';
import { NEUROTRACE_WORKFLOW_LINES } from '../workflowContent';
import { BuiltInInstructionTargetId } from './types';

export const CANONICAL_INSTRUCTIONS_RELATIVE_PATH = path.join('.neurotrace', 'instructions', 'AGENTS.md');
export const INSTRUCTION_SYNC_CONFIG_RELATIVE_PATH = path.join('.neurotrace', 'instructions', 'sync.json');
export const NEUROTRACE_AGENTS_START = '<!-- neurotrace-start -->';
export const NEUROTRACE_AGENTS_END = '<!-- neurotrace-end -->';
export const NEUROTRACE_COPILOT_MARKER = '<!-- neurotrace-copilot-instructions -->';
export const NEUROTRACE_COPILOT_START = '<!-- neurotrace-copilot-instructions:start -->';
export const NEUROTRACE_COPILOT_END = '<!-- neurotrace-copilot-instructions:end -->';

const BUILT_IN_TARGET_PATHS: Record<BuiltInInstructionTargetId, string> = {
    agents: 'AGENTS.md',
    claude: 'CLAUDE.md',
    copilot: path.join('.github', 'copilot-instructions.md'),
    cursor: path.join('.cursor', 'rules', 'neurotrace.mdc'),
};

const BUILT_IN_TARGET_LABELS: Record<BuiltInInstructionTargetId, string> = {
    agents: 'Workspace AGENTS.md',
    claude: 'CLAUDE.md',
    copilot: 'GitHub Copilot Instructions',
    cursor: 'Cursor Rule',
};

export function getDefaultInstructionContent(): string {
    return [
        '## NeuroTrace Workflow',
        '',
        ...NEUROTRACE_WORKFLOW_LINES,
    ].join('\n').trim() + '\n';
}

export function normalizeInstructionContent(value: string): string {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    return normalized ? `${normalized}\n` : '';
}

export function getBuiltInTargetPath(targetId: BuiltInInstructionTargetId): string {
    return BUILT_IN_TARGET_PATHS[targetId];
}

export function getBuiltInTargetLabel(targetId: BuiltInInstructionTargetId): string {
    return BUILT_IN_TARGET_LABELS[targetId];
}

export function extractManagedBlockContent(content: string, startMarker: string, endMarker: string): string | null {
    const normalized = content.replace(/\r\n/g, '\n');
    const startIndex = normalized.indexOf(startMarker);
    const endIndex = normalized.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        return null;
    }

    const blockContent = normalized.slice(startIndex + startMarker.length, endIndex).trim();
    return blockContent ? `${blockContent}\n` : '';
}

export function buildManagedMarkdownBlock(content: string, startMarker = NEUROTRACE_AGENTS_START, endMarker = NEUROTRACE_AGENTS_END): string {
    const normalized = normalizeInstructionContent(content);
    return [
        startMarker,
        normalized.trimEnd(),
        endMarker,
    ].join('\n');
}

export function upsertManagedMarkdownDocument(
    existingContent: string | null,
    content: string,
    options: {
        title?: string;
        startMarker?: string;
        endMarker?: string;
        legacyStartMarker?: string;
    } = {}
): string {
    const startMarker = options.startMarker ?? NEUROTRACE_AGENTS_START;
    const endMarker = options.endMarker ?? NEUROTRACE_AGENTS_END;
    const block = buildManagedMarkdownBlock(content, startMarker, endMarker);
    const normalized = existingContent?.replace(/\r\n/g, '\n') ?? '';

    if (!normalized.trim()) {
        const prefix = options.title ? `${options.title}\n\n` : '';
        return `${prefix}${block}\n`;
    }

    const startIndex = normalized.indexOf(startMarker);
    const endIndex = normalized.indexOf(endMarker);
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        const before = normalized.slice(0, startIndex);
        const after = normalized.slice(endIndex + endMarker.length);
        return `${before}${block}${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }

    if (options.legacyStartMarker && normalized.includes(options.legacyStartMarker)) {
        const legacyStartIndex = normalized.indexOf(options.legacyStartMarker);
        const before = normalized.slice(0, legacyStartIndex).trimEnd();
        return `${before ? `${before}\n\n` : ''}${block}\n`;
    }

    const separator = normalized.endsWith('\n') ? '\n' : '\n\n';
    return `${normalized}${separator}${block}\n`;
}

export function buildCursorRuleContent(content: string): string {
    const normalized = normalizeInstructionContent(content).trimEnd();
    return [
        '---',
        'description: Synced NeuroTrace instructions',
        'alwaysApply: true',
        '---',
        '',
        normalized,
        '',
    ].join('\n');
}

export function buildCopilotInstructionDocument(existingContent: string | null, content: string): string {
    const adjustedContent = normalizeInstructionContent(content).replace(/`neurotrace_/g, '`#neurotrace_');
    return upsertManagedMarkdownDocument(existingContent, adjustedContent, {
        title: '# Copilot Instructions',
        startMarker: NEUROTRACE_COPILOT_START,
        endMarker: NEUROTRACE_COPILOT_END,
        legacyStartMarker: NEUROTRACE_COPILOT_MARKER,
    });
}
