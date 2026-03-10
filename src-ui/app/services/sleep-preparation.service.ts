import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, map, shareReplay, Subject } from 'rxjs';
import { AutomationConfigService } from './automation-config.service';
import { listen } from '@tauri-apps/api/event';
import { info } from '@tauri-apps/plugin-log';
import { ResearchLogService } from './research-log.service';
import { ResearchEventSource } from '../models/research-log';

const SLEEP_PREPARATION_TIMEOUT = 5000;

@Injectable({
  providedIn: 'root',
})
export class SleepPreparationService {
  private readonly _sleepPreparationTimedOut = new BehaviorSubject<boolean>(false);
  public readonly sleepPreparationTimedOut = this._sleepPreparationTimedOut.asObservable();
  private readonly _onSleepPreparation = new Subject<void>();
  public readonly onSleepPreparation = this._onSleepPreparation.asObservable();

  public readonly sleepPreparationAvailable = this.automationConfigService.configs.pipe(
    map((configs) =>
      [
        configs.CHANGE_STATUS_GENERAL_EVENTS.changeStatusOnSleepPreparation,
        configs.CHANGE_STATUS_GENERAL_EVENTS.changeStatusMessageOnSleepPreparation,
        configs.DEVICE_POWER_AUTOMATIONS.turnOffDevicesOnSleepPreparation.devices.length > 0,
        configs.DEVICE_POWER_AUTOMATIONS.turnOffDevicesOnSleepPreparation.tagIds.length > 0,
        configs.DEVICE_POWER_AUTOMATIONS.turnOffDevicesOnSleepPreparation.types.length > 0,
        configs.VRCHAT_AVATAR_AUTOMATIONS.onSleepPreparation,
        (configs.OSC_GENERAL.onSleepPreparation?.commands.length ?? 0) > 0,
        configs.AUTO_ACCEPT_INVITE_REQUESTS.presetOnSleepPreparation !== null,
        configs.BIGSCREEN_BEYOND_FAN_CONTROL.onSleepPreparation,
        configs.BIGSCREEN_BEYOND_RGB_CONTROL.onSleepPreparation,
        configs.BRIGHTNESS_AUTOMATIONS.SLEEP_PREPARATION.enabled,
        configs.AUDIO_DEVICE_AUTOMATIONS.onSleepPreparationAutomations.length > 0,
        configs.VRCHAT_MIC_MUTE_AUTOMATIONS.onSleepPreparation !== 'NONE',
        configs.SYSTEM_MIC_MUTE_AUTOMATIONS.onSleepPreparationState !== 'NONE',
        configs.VRCHAT_GROUP_AUTOMATIONS.representGroupIdOnSleepPreparation !== 'DONT_CHANGE',
        configs.FRAME_LIMIT_AUTOMATIONS.configs.some((c) => c.onSleepPreparation !== 'NONE'),
        configs.SYSTEM_MIC_MUTE_AUTOMATIONS.controllerBinding &&
          configs.SYSTEM_MIC_MUTE_AUTOMATIONS.onSleepPreparationControllerBindingBehavior !==
            'NONE',
      ].some(Boolean)
    ),
    shareReplay(1)
  );

  constructor(
    private automationConfigService: AutomationConfigService,
    private researchLog: ResearchLogService
  ) {}

  public async init() {
    await listen('prepareForSleep', async () => {
      await this.prepareForSleep('user_overlay');
    });
  }

  public async prepareForSleep(source: ResearchEventSource = 'unknown') {
    if (
      (await firstValueFrom(this.sleepPreparationAvailable)) &&
      !this._sleepPreparationTimedOut.value
    ) {
      this._sleepPreparationTimedOut.next(true);
      this._onSleepPreparation.next();
      this.researchLog.logSleepPreparationStarted(source, {
        available: true,
        cooldown_active: true,
      });
      setTimeout(() => this._sleepPreparationTimedOut.next(false), SLEEP_PREPARATION_TIMEOUT);
      setTimeout(() => {
        this.researchLog.logSleepPreparationTimedOut({
          timeout_ms: SLEEP_PREPARATION_TIMEOUT,
        });
      }, SLEEP_PREPARATION_TIMEOUT);
      await info('[SleepPreparation] Running sleep preparation automations');
    }
  }
}
