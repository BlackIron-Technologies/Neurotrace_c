/*
MIT License

Copyright (c) 2025 BlackIron Technologies Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import config from './config.json';

interface TelemetryEvent {
    eventType: 'thought_created' | 'graph_opened' | 'suggest_related_used' | 'semantic_search_used' | 'semantic_ai_graph_used';
    timestamp: string;
    anonymousId: string;
    metadata?: {
        thoughtType?: string;
        hasCodeSnippet?: boolean;
        searchTermLength?: number;
        resultCount?: number;
        [key: string]: any;
    };
}

interface TelemetryData {
    sessionId: string;
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
    weekStart: string;
    events: TelemetryEvent[];
    aggregatedStats: {
        thoughtsCreated: number;
        graphOpened: number;
        suggestRelatedUsed: number;
        semanticSearchUsed: number;
        semanticAiGraphUsed: number;
        uniqueDaysActive: number;
    };
}

export class TelemetryManager {
    private storageUri: vscode.Uri;
    private telemetryFile: string;
    private anonymousId: string;
    private sessionId: string;
    private submissionTimer: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private isEnabled: boolean = false;
    private activeDays: Set<string> = new Set();

    // Retry configuration
    private readonly SUBMISSION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours (daily)
    private readonly RETRY_DELAYS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000]; // 30min, 2h, 6h
    private readonly MAX_DATA_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days (data retention)
    private retryCount: number = 0;

    constructor(private context: vscode.ExtensionContext) {
        this.storageUri = context.globalStorageUri;
        this.telemetryFile = path.join(this.storageUri.fsPath, 'telemetry_data.json');

        this.anonymousId = this.getOrCreateAnonymousId();
        this.sessionId = this.generateSessionId();
        this.initializeTelemetry();
    }

    private async initializeTelemetry(): Promise<void> {
        this.isEnabled = this.context.globalState.get('telemetryEnabled', false);

        if (this.isEnabled) {
            await this.ensureStorageDir();
            await this.cleanOldData(); // Remove data older than 30 days
            await this.setupSubmissionSchedule();
            this.trackDailyActivity();
        }
    }

    public async updateTelemetryStatus(enabled: boolean): Promise<void> {
        const wasEnabled = this.isEnabled;
        this.isEnabled = enabled;

        if (enabled && !wasEnabled) {
            await this.ensureStorageDir();
            await this.setupSubmissionSchedule();
            this.trackDailyActivity();
            console.log('NeuroTrace: Telemetry enabled');
        } else if (!enabled && wasEnabled) {
            this.clearTimers();
            await this.clearTelemetryData();
            console.log('NeuroTrace: Telemetry disabled and data cleared');
        }
    }

    private getOrCreateAnonymousId(): string {
        let anonymousId = this.context.globalState.get<string>('anonymousId');
        if (!anonymousId) {
            anonymousId = crypto.randomUUID();
            this.context.globalState.update('anonymousId', anonymousId);
        }
        return anonymousId;
    }

    private generateSessionId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private async ensureStorageDir(): Promise<void> {
        try {
            await vscode.workspace.fs.createDirectory(this.storageUri);
        } catch (error) {
            // Directory might already exist
        }
    }

    private trackDailyActivity(): void {
        const today = new Date().toISOString().split('T')[0];
        this.activeDays.add(today);
    }

    /**
     * Setup submission schedule based on installation date
     * Submits every 24 hours from when telemetry was first enabled
     */
    private async setupSubmissionSchedule(): Promise<void> {
        // Get or set the first activation timestamp
        let firstActivation = this.context.globalState.get<number>('telemetryFirstActivation');

        if (!firstActivation) {
            firstActivation = Date.now();
            await this.context.globalState.update('telemetryFirstActivation', firstActivation);
        }

        const now = Date.now();
        const timeSinceActivation = now - firstActivation;
        const cyclesSinceActivation = Math.floor(timeSinceActivation / this.SUBMISSION_INTERVAL);
        const nextSubmissionTime = firstActivation + ((cyclesSinceActivation + 1) * this.SUBMISSION_INTERVAL);
        const timeUntilNextSubmission = nextSubmissionTime - now;

        console.log(`NeuroTrace: Next telemetry submission in ${Math.round(timeUntilNextSubmission / (60 * 60 * 1000))} hours`);

        // Clear existing timer if any
        this.clearTimers();

        // Schedule next submission
        this.submissionTimer = setTimeout(async () => {
            await this.attemptSubmission();

            // Setup recurring submission every 24 hours
            this.submissionTimer = setInterval(async () => {
                await this.attemptSubmission();
            }, this.SUBMISSION_INTERVAL);
        }, timeUntilNextSubmission);
    }

    /**
     * Attempt to submit telemetry data with connectivity check
     */
    private async attemptSubmission(): Promise<void> {
        this.retryCount = 0; // Reset retry counter for new submission cycle

        if (!await this.checkConnectivity()) {
            console.log('NeuroTrace: No internet connectivity, scheduling retry');
            this.scheduleRetry();
            return;
        }

        await this.submitTelemetryData();
    }

    /**
     * Check if there's internet connectivity
     */
    private async checkConnectivity(): Promise<boolean> {
        try {
            // Try to reach a reliable endpoint (VS Code marketplace or similar)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

            const response = await fetch('https://marketplace.visualstudio.com/', {
                method: 'HEAD',
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    /**
     * Schedule a retry attempt with exponential backoff
     */
    private scheduleRetry(): void {
        if (this.retryCount >= this.RETRY_DELAYS.length) {
            console.log('NeuroTrace: Max retries reached, will try again in next submission cycle');
            return;
        }

        const delay = this.RETRY_DELAYS[this.retryCount];
        console.log(`NeuroTrace: Scheduling retry ${this.retryCount + 1}/${this.RETRY_DELAYS.length} in ${delay / (60 * 60 * 1000)} hours`);

        this.retryTimer = setTimeout(async () => {
            this.retryCount++;

            if (!await this.checkConnectivity()) {
                console.log('NeuroTrace: Still no connectivity, scheduling next retry');
                this.scheduleRetry();
                return;
            }

            await this.submitTelemetryData();
        }, delay);
    }

    /**
     * Clear all active timers
     */
    private clearTimers(): void {
        if (this.submissionTimer) {
            clearTimeout(this.submissionTimer);
            clearInterval(this.submissionTimer);
            this.submissionTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    /**
     * Clean data older than 7 days for privacy
     */
    private async cleanOldData(): Promise<void> {
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.telemetryFile));
            const telemetryData: TelemetryData = JSON.parse(data.toString());

            const now = Date.now();
            const cutoffDate = now - this.MAX_DATA_AGE;

            // Filter out events older than 7 days
            const filteredEvents = telemetryData.events.filter(event => {
                const eventTime = new Date(event.timestamp).getTime();
                return eventTime > cutoffDate;
            });

            if (filteredEvents.length < telemetryData.events.length) {
                telemetryData.events = filteredEvents;
                const dataString = JSON.stringify(telemetryData, null, 2);
                await vscode.workspace.fs.writeFile(vscode.Uri.file(this.telemetryFile), Buffer.from(dataString));
                console.log(`NeuroTrace: Cleaned ${telemetryData.events.length - filteredEvents.length} old events`);
            }
        } catch (error) {
            // File doesn't exist or error reading, ignore
        }
    }

    public async trackEvent(
        eventType: TelemetryEvent['eventType'],
        metadata?: TelemetryEvent['metadata']
    ): Promise<void> {
        if (!this.isEnabled) {
            return;
        }

        this.trackDailyActivity();

        const event: TelemetryEvent = {
            eventType,
            timestamp: new Date().toISOString(),
            anonymousId: this.anonymousId,
            metadata
        };

        try {
            await this.appendEventToFile(event);
        } catch (error) {
            console.error('NeuroTrace: Failed to track telemetry event:', error);
        }
    }

    private async appendEventToFile(event: TelemetryEvent): Promise<void> {
        await this.ensureStorageDir();

        let telemetryData: TelemetryData;

        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.telemetryFile));
            telemetryData = JSON.parse(data.toString());
        } catch (error) {
            telemetryData = this.createEmptyTelemetryData();
        }

        // Add the event
        telemetryData.events.push(event);

        // Update aggregated stats
        this.updateAggregatedStats(telemetryData, event);

        // Save back to file
        const dataString = JSON.stringify(telemetryData, null, 2);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(this.telemetryFile), Buffer.from(dataString));
    }

    private createEmptyTelemetryData(): TelemetryData {
        const weekStart = this.getWeekStart();
        return {
            sessionId: this.sessionId,
            extensionVersion: this.context.extension.packageJSON.version || 'unknown',
            vscodeVersion: vscode.version,
            platform: process.platform,
            weekStart,
            events: [],
            aggregatedStats: {
                thoughtsCreated: 0,
                graphOpened: 0,
                suggestRelatedUsed: 0,
                semanticSearchUsed: 0,
                semanticAiGraphUsed: 0,
                uniqueDaysActive: 0
            }
        };
    }

    private getWeekStart(): string {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setUTCDate(now.getUTCDate() - now.getUTCDay() + 1);
        startOfWeek.setUTCHours(0, 0, 0, 0);
        return startOfWeek.toISOString().split('T')[0];
    }

    private updateAggregatedStats(telemetryData: TelemetryData, event: TelemetryEvent): void {
        switch (event.eventType) {
            case 'thought_created':
                telemetryData.aggregatedStats.thoughtsCreated++;
                break;
            case 'graph_opened':
                telemetryData.aggregatedStats.graphOpened++;
                break;
            case 'suggest_related_used':
                telemetryData.aggregatedStats.suggestRelatedUsed++;
                break;
            case 'semantic_search_used':
                telemetryData.aggregatedStats.semanticSearchUsed++;
                break;
            case 'semantic_ai_graph_used':
                telemetryData.aggregatedStats.semanticAiGraphUsed++;
                break;
        }

        telemetryData.aggregatedStats.uniqueDaysActive = this.activeDays.size;
    }

    private async submitTelemetryData(): Promise<void> {
        if (!this.isEnabled) {
            return;
        }

        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.telemetryFile));
            const telemetryData: TelemetryData = JSON.parse(data.toString());

            if (telemetryData.events.length === 0) {
                console.log('NeuroTrace: No telemetry events to submit');
                return;
            }

            // Submit to backend
            await this.sendToBackend(telemetryData);

            // Clear local data after successful submission
            await this.clearTelemetryData();

            console.log('NeuroTrace: Telemetry data submitted successfully');

            // Reset retry count on successful submission
            this.retryCount = 0;

            // Clear any pending retry timers
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
        } catch (error) {
            console.error('NeuroTrace: Failed to submit telemetry data:', error);

            // Schedule retry if we haven't exceeded max retries
            if (this.retryCount < this.RETRY_DELAYS.length) {
                this.scheduleRetry();
            }
        }
    }

    private async sendToBackend(telemetryData: TelemetryData): Promise<void> {
        const TELEMETRY_ENDPOINT = `${config.telemetryUrl}${config.telemetryEndpoint}`;

        try {
            // Check payload size before sending (server has 1MB limit)
            const payloadSize = JSON.stringify(telemetryData).length;
            if (payloadSize > 900000) { // 900KB safety margin
                console.warn(`NeuroTrace: Telemetry payload too large (${payloadSize} bytes), truncating events`);
                telemetryData.events = telemetryData.events.slice(-500); // Keep last 500 events
            }

            const response = await fetch(TELEMETRY_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': `NeuroTrace/${telemetryData.extensionVersion}`
                },
                body: JSON.stringify(telemetryData)
            });

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('Rate limit exceeded. Will retry later.');
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            console.log('NeuroTrace: Telemetry submitted:', result);
        } catch (error) {
            console.error('NeuroTrace: Failed to send telemetry to backend:', error);
            throw error;
        }
    }

    private async clearTelemetryData(): Promise<void> {
        try {
            this.activeDays.clear();
            await vscode.workspace.fs.delete(vscode.Uri.file(this.telemetryFile));
        } catch (error) {
            // File might not exist, which is fine
        }
    }

    public dispose(): void {
        this.clearTimers();
    }

    // Public method for manual telemetry submission (for testing/debugging)
    public async manualSubmit(): Promise<void> {
        if (!this.isEnabled) {
            vscode.window.showWarningMessage('Telemetry is disabled');
            return;
        }

        await this.submitTelemetryData();
        vscode.window.showInformationMessage('Telemetry data submitted manually');
    }

    // Get current telemetry status for debugging
    public async getTelemetryStatus(): Promise<{
        enabled: boolean;
        anonymousId: string;
        sessionId: string;
        eventCount: number;
        weekStart: string;
    }> {
        let eventCount = 0;
        let weekStart = 'N/A';

        if (this.isEnabled) {
            try {
                const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.telemetryFile));
                const telemetryData: TelemetryData = JSON.parse(data.toString());
                eventCount = telemetryData.events.length;
                weekStart = telemetryData.weekStart;
            } catch (error) {
                // File doesn't exist yet
            }
        }

        return {
            enabled: this.isEnabled,
            anonymousId: this.anonymousId,
            sessionId: this.sessionId,
            eventCount,
            weekStart
        };
    }
}