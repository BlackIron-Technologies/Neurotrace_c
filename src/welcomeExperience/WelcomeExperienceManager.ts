import * as vscode from 'vscode';

const LAST_SEEN_EXTENSION_VERSION_KEY = 'neurotrace.lastSeenExtensionVersion';
const LAST_SHOWN_WHATS_NEW_VERSION_KEY = 'neurotrace.lastShownWhatsNewVersion';
const FIRST_INSTALL_RESOURCE_PATH = 'walkthrough/init.md';

interface WhatsNewNotice {
    version: string;
}

// Only versions listed here will auto-open a What's New page after update.
const WHATS_NEW_NOTICES: readonly WhatsNewNotice[] = [
    {
        version: '1.1.5'
    },
    {
        version: '1.2.0'
    },
    {
        version: '1.2.1'
    },
    {
        version: '1.2.2'
    }
];
const WHATS_NEW_RESOURCE_PATH = 'walkthrough/whats-new.md';

export class WelcomeExperienceManager {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public async maybeShow(): Promise<void> {
        const currentVersion = this.getCurrentVersion();
        if (!currentVersion) {
            return;
        }

        const lastSeenVersion = this.context.globalState.get<string>(LAST_SEEN_EXTENSION_VERSION_KEY);
        const notice = WHATS_NEW_NOTICES.find(entry => entry.version === currentVersion);
        const lastShownWhatsNewVersion = this.context.globalState.get<string>(LAST_SHOWN_WHATS_NEW_VERSION_KEY);

        if (!lastSeenVersion) {
            await this.context.globalState.update(LAST_SEEN_EXTENSION_VERSION_KEY, currentVersion);
            if (notice) {
                await this.context.globalState.update(LAST_SHOWN_WHATS_NEW_VERSION_KEY, currentVersion);
            }
            await this.openMarkdownPreview(FIRST_INSTALL_RESOURCE_PATH, 'NeuroTrace walkthrough');
            return;
        }

        if (lastSeenVersion === currentVersion) {
            if (notice && lastShownWhatsNewVersion !== currentVersion) {
                await this.context.globalState.update(LAST_SHOWN_WHATS_NEW_VERSION_KEY, currentVersion);
                await this.openMarkdownPreview(WHATS_NEW_RESOURCE_PATH, this.getWhatsNewTitle(notice.version));
            }
            return;
        }

        await this.context.globalState.update(LAST_SEEN_EXTENSION_VERSION_KEY, currentVersion);
        if (!notice) {
            return;
        }

        if (lastShownWhatsNewVersion === currentVersion) {
            return;
        }

        await this.context.globalState.update(LAST_SHOWN_WHATS_NEW_VERSION_KEY, currentVersion);
        await this.openMarkdownPreview(WHATS_NEW_RESOURCE_PATH, this.getWhatsNewTitle(notice.version));
    }

    private getCurrentVersion(): string | null {
        const version = this.context.extension.packageJSON.version;
        return typeof version === 'string' && version.trim().length > 0 ? version : null;
    }

    private getWhatsNewTitle(version: string): string {
        return `What's New in NeuroTrace ${version}`;
    }

    private async openMarkdownPreview(relativePath: string, title: string): Promise<void> {
        const resource = vscode.Uri.joinPath(this.context.extensionUri, ...relativePath.split('/'));

        try {
            await vscode.workspace.fs.stat(resource);
        } catch {
            console.warn(`NeuroTrace: ${title} resource not found at ${resource.fsPath}`);
            return;
        }

        try {
            await vscode.commands.executeCommand('markdown.showPreview', resource);
        } catch (error) {
            console.warn(`NeuroTrace: Failed to preview ${title}, falling back to text editor.`, error);
            const doc = await vscode.workspace.openTextDocument(resource);
            await vscode.window.showTextDocument(doc, { preview: false });
        }
    }
}
