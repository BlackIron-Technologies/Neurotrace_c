import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import AdmZip = require('adm-zip');

export async function activateBackendArchive(options: {
    archive: string; checksums: string; installRoot: string; platform: string; version: string;
    readVersion: (executable: string) => string | null; beforeActivate: () => void | Promise<void>;
}): Promise<string> {
    const root = path.resolve(options.installRoot);
    const parent = path.dirname(root);
    fs.mkdirSync(parent, { recursive: true });
    const bytes = fs.readFileSync(options.archive);
    const filename = `neurotrace-${options.platform}.zip`;
    const expected = fs.readFileSync(options.checksums, 'utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === filename)?.[0];
    if (!expected || !/^[a-f\d]{64}$/i.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
        throw new Error('The downloaded backend failed its release checksum verification. The previous backend was kept.');
    }
    const stage = fs.mkdtempSync(path.join(parent, '.neurotrace-stage-'));
    const backup = path.join(parent, '.neurotrace-backup-' + randomUUID());
    let activated = false;
    let oldMoved = false;
    try {
        const archive = new AdmZip(bytes);
        for (const entry of archive.getEntries()) {
            const name = entry.entryName.replace(/\\/g, '/');
            const target = path.resolve(stage, name);
            if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || !target.startsWith(stage + path.sep) || ((entry.header.attr >>> 16) & 0o170000) === 0o120000) {
                throw new Error('The backend archive contains an unsafe entry');
            }
        }
        archive.extractAllTo(stage, true, true);
        const executableName = options.platform === 'windows' ? 'neurotrace.exe' : 'neurotrace';
        const executable = path.join(stage, executableName);
        const metadata = JSON.parse(fs.readFileSync(path.join(stage, 'build-info.json'), 'utf8'));
        if (!fs.statSync(path.join(stage, '_internal')).isDirectory() || metadata.version !== options.version || metadata.platform !== options.platform || fs.readFileSync(path.join(stage, 'backend-binary-version.txt'), 'utf8').trim() !== options.version) {
            throw new Error('The backend archive does not match the requested platform and version');
        }
        if (options.platform !== 'windows') { fs.chmodSync(executable, 0o755); }
        if (options.readVersion(executable) !== options.version) {
            throw new Error('The downloaded executable did not report the required backend version');
        }
        await options.beforeActivate();
        if (fs.existsSync(root)) { fs.renameSync(root, backup); oldMoved = true; }
        try { fs.renameSync(stage, root); activated = true; }
        catch (error) {
            if (oldMoved) { fs.renameSync(backup, root); oldMoved = false; }
            throw error;
        }
        if (oldMoved) {
            try { fs.rmSync(backup, { recursive: true }); }
            catch (error) { console.warn(`Backend updated; previous files remain at ${backup}:`, error); }
        }
        return path.join(root, executableName);
    } finally {
        if (!activated) { fs.rmSync(stage, { recursive: true, force: true }); }
    }
}
