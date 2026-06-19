import * as vscode from 'vscode';

export interface UsageStats {
    monthlyThoughtCount: number;
    countResetDate: string;
}

export class GlobalUsageManager {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public async getUsageStats(): Promise<UsageStats> {
        const currentMonth = new Date().toISOString().slice(0, 7);
        return {
            monthlyThoughtCount: 0,
            countResetDate: currentMonth
        };
    }

    public async incrementCount(): Promise<void> {
        return;
    }

    public async isWithinLimits(): Promise<boolean> {
        return true;
    }

    public async validateLocalCount(): Promise<boolean> {
        return true;
    }

    public async getUsageDisplayText(): Promise<string> {
        return 'Unlimited memories';
    }
}
