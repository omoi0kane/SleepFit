import { Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { map } from 'rxjs';
import {
  AUTOMATION_CONFIGS_DEFAULT,
  SleepWakeTransitionsConfig,
} from '../models/automations';
import { AutomationConfigService } from './automation-config.service';
import { SleepWakeTransitionService } from './sleep-wake-transition.service';

@Injectable({
  providedIn: 'root',
})
export class SleepWakeTransitionScheduleAutomationService {
  private config: SleepWakeTransitionsConfig = structuredClone(
    AUTOMATION_CONFIGS_DEFAULT.SLEEP_WAKE_TRANSITIONS
  );

  constructor(
    private automationConfig: AutomationConfigService,
    private sleepWakeTransitions: SleepWakeTransitionService
  ) {}

  async init() {
    this.automationConfig.configs
      .pipe(map((configs) => configs.SLEEP_WAKE_TRANSITIONS))
      .subscribe((config) => (this.config = config));
    await listen<void>('CRON_MINUTE_START', () => this.onTick());
  }

  async onTick() {
    if (!this.config.enabled) return;
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    if (
      this.config.schedules.sleepEnabled &&
      this.config.schedules.sleepStartTime &&
      this.matchesTime(this.config.schedules.sleepStartTime, currentHour, currentMinute)
    ) {
      if (this.sleepWakeTransitions.consumeSkipNextSleepSchedule()) return;
      await this.sleepWakeTransitions.startScheduledProfile('sleep');
      return;
    }

    if (
      this.config.schedules.wakeEnabled &&
      this.config.schedules.wakeStartTime &&
      this.matchesTime(this.config.schedules.wakeStartTime, currentHour, currentMinute)
    ) {
      await this.sleepWakeTransitions.startScheduledProfile('wake');
    }
  }

  private matchesTime(time: string, currentHour: number, currentMinute: number) {
    const [scheduledHour, scheduledMinute] = time
      .split(':')
      .map((component) => parseInt(component, 10));
    return currentHour === scheduledHour && currentMinute === scheduledMinute;
  }
}
