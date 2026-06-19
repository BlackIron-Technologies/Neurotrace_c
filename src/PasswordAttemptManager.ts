import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface PasswordAttemptData {
    failedAttempts: number;
    lockedUntil: string | null;
    lastAttemptAt: string | null;
}

export class PasswordAttemptManager {
    private storageUri: vscode.Uri;
    private storageFile: string;
    private readonly MAX_ATTEMPTS = 5;
    private readonly LOCKOUT_DURATION_MS = 60 * 60 * 1000;

    constructor(private context: vscode.ExtensionContext) {
        this.storageUri = context.globalStorageUri;
        this.storageFile = path.join(this.storageUri.fsPath, 'password_attempts.json');
    }

    private async ensureStorageDir(): Promise<void> {
        try {
            await vscode.workspace.fs.createDirectory(this.storageUri);
        } catch (error) {
            console.error('NeuroTrace: Failed to create storage directory:', error);
        }
    }

    private async readAttemptData(): Promise<PasswordAttemptData> {
        await this.ensureStorageDir();
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.storageFile));
            return JSON.parse(data.toString());
        } catch (error) {
            return {
                failedAttempts: 0,
                lockedUntil: null,
                lastAttemptAt: null
            };
        }
    }

    private async writeAttemptData(data: PasswordAttemptData): Promise<void> {
        await this.ensureStorageDir();
        const jsonData = JSON.stringify(data, null, 2);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(this.storageFile), Buffer.from(jsonData));
    }

    public async isLocked(): Promise<{ locked: boolean; remainingMinutes?: number }> {
        const data = await this.readAttemptData();

        if (!data.lockedUntil) {
            return { locked: false };
        }

        const lockedUntil = new Date(data.lockedUntil);
        const now = new Date();

        if (now < lockedUntil) {
            const remainingMs = lockedUntil.getTime() - now.getTime();
            const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
            return { locked: true, remainingMinutes };
        }

        await this.resetAttempts();
        return { locked: false };
    }

    public async recordFailedAttempt(): Promise<{
        attemptsRemaining: number;
        locked: boolean;
        lockoutMinutes?: number
    }> {
        const data = await this.readAttemptData();

        data.failedAttempts++;
        data.lastAttemptAt = new Date().toISOString();

        if (data.failedAttempts >= this.MAX_ATTEMPTS) {
            const lockedUntil = new Date(Date.now() + this.LOCKOUT_DURATION_MS);
            data.lockedUntil = lockedUntil.toISOString();
            await this.writeAttemptData(data);

            return {
                attemptsRemaining: 0,
                locked: true,
                lockoutMinutes: 60
            };
        }

        await this.writeAttemptData(data);

        return {
            attemptsRemaining: this.MAX_ATTEMPTS - data.failedAttempts,
            locked: false
        };
    }

    public async resetAttempts(): Promise<void> {
        const data: PasswordAttemptData = {
            failedAttempts: 0,
            lockedUntil: null,
            lastAttemptAt: null
        };
        await this.writeAttemptData(data);
    }

    public async getCurrentAttempts(): Promise<number> {
        const data = await this.readAttemptData();
        return data.failedAttempts;
    }
}
