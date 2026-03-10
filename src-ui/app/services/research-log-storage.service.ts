import { Injectable } from '@angular/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { info } from '@tauri-apps/plugin-log';
import { ResearchSessionFile } from '../models/research-log';

@Injectable({
  providedIn: 'root',
})
export class ResearchLogStorageService {
  private filePath: string | null = null;

  public async init(sessionId: string): Promise<string> {
    const now = new Date();
    const datePath = [
      now.getFullYear().toString(10),
      (now.getMonth() + 1).toString(10).padStart(2, '0'),
      now.getDate().toString(10).padStart(2, '0'),
    ].join('-');
    const basePath = await join(await appDataDir(), 'research-logs', datePath);
    await mkdir(basePath, { recursive: true });
    this.filePath = await join(basePath, `${sessionId}.json`);
    await info(`[ResearchLog] Initialized session file at ${this.filePath}`);
    return this.filePath;
  }

  public get currentFilePath(): string | null {
    return this.filePath;
  }

  public async writeSession(session: ResearchSessionFile) {
    if (!this.filePath) throw new Error('Research log storage not initialized');
    await writeTextFile(this.filePath, JSON.stringify(session, null, 2));
  }
}
