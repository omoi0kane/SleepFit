import { Injectable } from '@angular/core';
import { asyncScheduler, pairwise, skip, throttleTime } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { error, info, warn } from '@tauri-apps/plugin-log';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AppSettingsService } from './app-settings.service';
import { AutomationConfigService } from './automation-config.service';
import {
  ResearchDomain,
  ResearchEventSource,
  ResearchLogEvent,
  ResearchSessionFile,
  ResearchSettingChange,
} from '../models/research-log';
import { getVersion } from '../utils/app-utils';
import { ResearchLogStorageService } from './research-log-storage.service';
import { isEqual } from 'lodash';

const RESEARCH_LOG_SCHEMA_VERSION = 1;
const AUTOMATION_MEMORY_WINDOW_MS = 60_000;
const FLUSH_INTERVAL_MS = 5_000;
const HIGH_FREQUENCY_EVENT_WINDOW_MS = 1_000;
const MANUAL_EVENT_DEBOUNCE_MS = 400;

type PendingManualEvent = {
  eventType: ResearchLogEvent['event_type'];
  source: ResearchEventSource;
  payload: Record<string, unknown>;
  onRecorded?: () => void;
};

@Injectable({
  providedIn: 'root',
})
export class ResearchLogService {
  private initialized = false;
  private sessionId = uuidv4();
  private appVersion = 'unknown';
  private sessionStartedAt = new Date().toISOString();
  private sessionStoppedAt: string | null = null;
  private events: ResearchLogEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushInProgress = false;
  private dirty = false;
  private stopping = false;
  private lastHighFrequencyEventByKey = new Map<string, number>();
  private pendingManualEvents = new Map<string, PendingManualEvent>();
  private pendingManualEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastAutomationByDomain = new Map<
    ResearchDomain,
    { automationId: string; reason?: string | null; timestamp: number }
  >();

  constructor(
    private appSettings: AppSettingsService,
    private automationConfig: AutomationConfigService,
    private storage: ResearchLogStorageService
  ) {}

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.appVersion = await getVersion().catch(() => 'unknown');
    const filePath = await this.storage.init(this.sessionId);
    await this.bindStopHooks();
    this.bindSettingsLogging();
    this.logEvent('session_started', 'system', {
      research_log_path: filePath,
    });
    this.logEvent('app_started', 'system', {
      launch_mode: 'normal',
    });
    await this.flush();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  logSleepModeChange(
    enabled: boolean,
    source: ResearchEventSource,
    payload: {
      reason_type: string;
      automation_id?: string;
    }
  ) {
    if (!this.initialized) return;
    const eventType = enabled ? 'sleep_mode_enabled' : 'sleep_mode_disabled';
    this.logEvent(eventType, source, {
      enabled,
      ...payload,
    });
    if (source === 'automation' && payload.automation_id) {
      this.rememberAutomation('sleep_mode', payload.automation_id, payload.reason_type);
    }
    this.logPotentialManualIntervention('sleep_mode', source, eventType);
  }

  logSleepPreparationStarted(source: ResearchEventSource, payload: Record<string, unknown>) {
    this.logEvent('sleep_preparation_started', source, payload);
  }

  logSleepPreparationTimedOut(payload: Record<string, unknown>) {
    this.logEvent('sleep_preparation_timed_out', 'system', payload);
  }

  logBrightnessChanged(
    brightnessType: 'simple' | 'software' | 'hardware',
    source: ResearchEventSource,
    payload: {
      old_value: number | null;
      new_value: number;
      reason?: string | null;
      transition: boolean;
      source_detail?: string;
    }
  ) {
    const eventPayload = {
      brightness_type: brightnessType,
      ...payload,
    };
    if (source.startsWith('user_')) {
      this.queueManualEvent(
        `brightness:${brightnessType}:${source}`,
        'brightness_changed',
        source,
        eventPayload,
        () => this.logPotentialManualIntervention('brightness', source, 'brightness_changed')
      );
      return;
    }
    if (!this.shouldRecordHighFrequency(`brightness:${brightnessType}:${source}`)) return;
    this.logEvent('brightness_changed', source, eventPayload);
    if (source === 'automation' && payload.reason) {
      this.rememberAutomation('brightness', 'BRIGHTNESS_AUTOMATIONS', payload.reason);
    }
    this.logPotentialManualIntervention('brightness', source, 'brightness_changed');
  }

  logColorTemperatureChanged(
    source: ResearchEventSource,
    payload: {
      old_value: number | null;
      new_value: number;
      reason?: string | null;
      transition: boolean;
      source_detail?: string;
    }
  ) {
    if (source.startsWith('user_')) {
      this.queueManualEvent(
        `cct:${source}`,
        'color_temperature_changed',
        source,
        payload,
        () =>
          this.logPotentialManualIntervention(
            'color_temperature',
            source,
            'color_temperature_changed'
          )
      );
      return;
    }
    if (!this.shouldRecordHighFrequency(`cct:${source}`)) return;
    this.logEvent('color_temperature_changed', source, payload);
    if (source === 'automation' && payload.reason) {
      this.rememberAutomation('color_temperature', 'BRIGHTNESS_AUTOMATIONS', payload.reason);
    }
    this.logPotentialManualIntervention(
      'color_temperature',
      source,
      'color_temperature_changed'
    );
  }

  logVolumeChanged(
    source: ResearchEventSource,
    payload: {
      device_id: string;
      device_name?: string;
      device_type?: string;
      old_value: number | null;
      new_value: number;
      reason?: string | null;
      source_detail?: string;
    }
  ) {
    if (source.startsWith('user_')) {
      this.queueManualEvent(
        `volume:${payload.device_id}:${source}`,
        'volume_changed',
        source,
        payload,
        () => this.logPotentialManualIntervention('volume', source, 'volume_changed')
      );
      return;
    }
    if (!this.shouldRecordHighFrequency(`volume:${payload.device_id}:${source}`)) return;
    this.logEvent('volume_changed', source, payload);
    if (source === 'automation') {
      this.rememberAutomation('volume', 'AUDIO_DEVICE_AUTOMATIONS', payload.reason);
    }
    this.logPotentialManualIntervention('volume', source, 'volume_changed');
  }

  logOverlayOpened(source: ResearchEventSource, payload: Record<string, unknown>) {
    this.logEvent('overlay_opened', source, payload);
  }

  logAutomationFired(
    automationId: string,
    payload: {
      automation_event?: string;
      reason?: string;
      target?: string;
    }
  ) {
    this.logEvent('automation_fired', 'automation', {
      automation_id: automationId,
      ...payload,
    });
  }

  logAutomationCancelled(
    automationId: string,
    payload: {
      reason?: string;
      target?: string;
    }
  ) {
    this.logEvent('automation_cancelled', 'automation', {
      automation_id: automationId,
      ...payload,
    });
  }

  logError(
    domain: string,
    operation: string,
    message: string,
    recoverable = true,
    code?: string | null
  ) {
    this.logEvent('error', 'service', {
      domain,
      operation,
      message,
      code: code ?? null,
      recoverable,
    });
  }

  private logEvent(
    eventType: ResearchLogEvent['event_type'],
    source: ResearchEventSource,
    payload: Record<string, unknown>
  ): ResearchLogEvent | null {
    if (!this.initialized) return null;
    const event: ResearchLogEvent = {
      event_id: uuidv4(),
      timestamp: new Date().toISOString(),
      session_id: this.sessionId,
      event_type: eventType,
      source,
      app_version: this.appVersion,
      payload,
    };
    this.events.push(event);
    this.dirty = true;
    return event;
  }

  private bindSettingsLogging() {
    this.appSettings.settings
      .pipe(skip(1), pairwise(), throttleTime(500, asyncScheduler, { leading: false, trailing: true }))
      .subscribe(([previous, current]) => {
        this.logSettingDiff('app_settings', previous, current);
      });
    this.automationConfig.configs
      .pipe(skip(1), pairwise(), throttleTime(500, asyncScheduler, { leading: false, trailing: true }))
      .subscribe(([previous, current]) => {
        this.logSettingDiff('automation_configs', previous, current);
      });
  }

  private logSettingDiff(
    domain: 'app_settings' | 'automation_configs',
    previous: object,
    current: object
  ) {
    const changes = this.collectDiffs(
      previous as Record<string, unknown>,
      current as Record<string, unknown>
    );
    if (!changes.length) return;
    this.logEvent('setting_changed', 'system', {
      domain,
      changes,
    });
  }

  private collectDiffs(
    previous: Record<string, unknown>,
    current: Record<string, unknown>,
    prefix = ''
  ): ResearchSettingChange[] {
    const keys = Array.from(new Set([...Object.keys(previous), ...Object.keys(current)]));
    const changes: ResearchSettingChange[] = [];
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const oldValue = previous[key];
      const newValue = current[key];
      if (isEqual(oldValue, newValue)) continue;
      if (this.isPlainObject(oldValue) && this.isPlainObject(newValue)) {
        changes.push(
          ...this.collectDiffs(
            oldValue as Record<string, unknown>,
            newValue as Record<string, unknown>,
            path
          )
        );
        continue;
      }
      if (this.shouldRedact(path)) {
        changes.push({
          key: path,
          old_value: null,
          new_value: null,
          redacted: true,
        });
      } else {
        changes.push({
          key: path,
          old_value: this.sanitizeValue(oldValue),
          new_value: this.sanitizeValue(newValue),
        });
      }
    }
    return changes;
  }

  private sanitizeValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  private shouldRedact(path: string) {
    return /(password|cookie|token|secret|key|credential)/i.test(path);
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private rememberAutomation(domain: ResearchDomain, automationId: string, reason?: string | null) {
    this.lastAutomationByDomain.set(domain, {
      automationId,
      reason: reason ?? null,
      timestamp: Date.now(),
    });
  }

  private logPotentialManualIntervention(
    domain: ResearchDomain,
    source: ResearchEventSource,
    action: string
  ) {
    if (!source.startsWith('user_')) return;
    const lastAutomation = this.lastAutomationByDomain.get(domain);
    if (!lastAutomation) return;
    if (Date.now() - lastAutomation.timestamp > AUTOMATION_MEMORY_WINDOW_MS) return;
    this.logEvent('manual_intervention', source, {
      domain,
      action,
      previous_automation_id: lastAutomation.automationId,
      previous_reason: lastAutomation.reason ?? null,
    });
  }

  private shouldRecordHighFrequency(key: string) {
    const now = Date.now();
    const last = this.lastHighFrequencyEventByKey.get(key) ?? 0;
    if (now - last < HIGH_FREQUENCY_EVENT_WINDOW_MS) return false;
    this.lastHighFrequencyEventByKey.set(key, now);
    return true;
  }

  private queueManualEvent(
    key: string,
    eventType: ResearchLogEvent['event_type'],
    source: ResearchEventSource,
    payload: Record<string, unknown>,
    onRecorded?: () => void
  ) {
    const existingTimer = this.pendingManualEventTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    this.pendingManualEvents.set(key, {
      eventType,
      source,
      payload,
      onRecorded,
    });
    this.pendingManualEventTimers.set(
      key,
      setTimeout(() => {
        const event = this.pendingManualEvents.get(key);
        if (!event) return;
        this.logEvent(event.eventType, event.source, event.payload);
        event.onRecorded?.();
        this.pendingManualEvents.delete(key);
        this.pendingManualEventTimers.delete(key);
      }, MANUAL_EVENT_DEBOUNCE_MS)
    );
  }

  private async bindStopHooks() {
    const stopForWindowClose = () => {
      void this.stopSession('window_close');
    };
    const stopForProcessExit = () => {
      void this.stopSession('process_exit');
    };

    await listen('APP_CLOSE_REQUESTED', () => {
      void this.stopSession('window_close', true);
    });
    window.addEventListener('beforeunload', stopForWindowClose);
    window.addEventListener('unload', stopForProcessExit);
  }

  private async stopSession(reason: string, closeWindowAfterFlush = false) {
    if (!this.initialized || this.sessionStoppedAt || this.stopping) return;
    this.stopping = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPendingManualEvents();
    await this.waitForPendingFlush();
    this.sessionStoppedAt = new Date().toISOString();
    this.logEvent('app_stopped', 'system', {
      reason,
    });
    const sessionStoppedEvent = this.logEvent('session_stopped', 'system', {
      event_count: this.events.length,
      flush_success: false,
    });
    try {
      const flushed = await this.flush(true);
      if (flushed && sessionStoppedEvent) {
        sessionStoppedEvent.payload['flush_success'] = true;
        this.dirty = true;
        await this.flush(true);
      }
      if (closeWindowAfterFlush) {
        await invoke('complete_app_close');
      }
    } catch (e) {
      await error('[ResearchLog] Final flush failed: ' + e);
    } finally {
      this.stopping = false;
    }
  }

  private async flush(force = false): Promise<boolean> {
    if (this.flushInProgress) {
      if (!force) return false;
      await this.waitForPendingFlush();
    }
    if (!this.dirty && !force) return false;
    this.flushInProgress = true;
    try {
      const sessionFile: ResearchSessionFile = {
        schema_version: RESEARCH_LOG_SCHEMA_VERSION,
        session_id: this.sessionId,
        app_version: this.appVersion,
        started_at: this.sessionStartedAt,
        stopped_at: this.sessionStoppedAt,
        platform: 'windows',
        events: [...this.events],
      };
      await this.storage.writeSession(sessionFile);
      this.dirty = false;
      await info(`[ResearchLog] Flushed ${this.events.length} event(s)`);
      return true;
    } catch (e) {
      await warn('[ResearchLog] Flush failed: ' + e);
      this.logEvent('error', 'service', {
        domain: 'research_log',
        operation: 'flush',
        message: `${e}`,
        recoverable: true,
      });
      return false;
    } finally {
      this.flushInProgress = false;
    }
  }

  private async waitForPendingFlush() {
    while (this.flushInProgress) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private flushPendingManualEvents() {
    for (const timer of this.pendingManualEventTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingManualEventTimers.clear();
    for (const event of this.pendingManualEvents.values()) {
      this.logEvent(event.eventType, event.source, event.payload);
      event.onRecorded?.();
    }
    this.pendingManualEvents.clear();
  }
}
