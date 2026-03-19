import { Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { BehaviorSubject, firstValueFrom, merge } from 'rxjs';
import {
  AUTOMATION_CONFIGS_DEFAULT,
  SleepWakeTransitionProfileType,
  SleepWakeTransitionStep,
  SleepWakeTransitionTarget,
  SleepWakeTransitionsConfig,
} from '../models/automations';
import { AutomationConfigService } from './automation-config.service';
import { AudioDeviceService } from './audio-device.service';
import { CCTControlService } from './cct-control/cct-control.service';
import { EventLogService } from './event-log.service';
import {
  EventLogSleepWakeTransitionCancelled,
  EventLogSleepWakeTransitionFinished,
  EventLogSleepWakeTransitionStarted,
} from '../models/event-log-entry';
import { HardwareBrightnessControlService } from './brightness-control/hardware-brightness-control.service';
import { ResearchEventSource } from '../models/research-log';
import { ResearchLogService } from './research-log.service';
import { SimpleBrightnessControlService } from './brightness-control/simple-brightness-control.service';
import { SoftwareBrightnessControlService } from './brightness-control/software-brightness-control.service';

export type SleepWakeTransitionStatus =
  | 'idle'
  | 'scheduled_running'
  | 'manual_applied'
  | 'reverting'
  | 'cancelled';

type TransitionDomainLocks = {
  brightness: boolean;
  cct: boolean;
  volume: boolean;
};

export interface SleepWakeTransitionState {
  status: SleepWakeTransitionStatus;
  profile: SleepWakeTransitionProfileType | null;
  appliedDomains: TransitionDomainLocks;
  lastTrigger: 'manual' | 'scheduled' | null;
}

type RunContext = {
  profile: SleepWakeTransitionProfileType;
  source: ResearchEventSource;
  reason: 'MANUAL' | 'SCHEDULED';
  timeoutIds: ReturnType<typeof setTimeout>[];
  volumeTimeoutIds: ReturnType<typeof setTimeout>[];
  domainLocks: TransitionDomainLocks;
  cancelEndBehavior: boolean;
};

@Injectable({
  providedIn: 'root',
})
export class SleepWakeTransitionService {
  private config: SleepWakeTransitionsConfig = structuredClone(
    AUTOMATION_CONFIGS_DEFAULT.SLEEP_WAKE_TRANSITIONS
  );
  private readonly _state = new BehaviorSubject<SleepWakeTransitionState>({
    status: 'idle',
    profile: null,
    appliedDomains: {
      brightness: false,
      cct: false,
      volume: false,
    },
    lastTrigger: null,
  });
  public readonly state = this._state.asObservable();

  private currentRun: RunContext | null = null;
  private skipNextSleepSchedule = false;
  // Debug-only UI support:
  // expose whether the next scheduled sleep run will be skipped so testers can
  // intentionally clear it without restarting the app during short schedule tests.
  private readonly _skipNextSleepScheduleActive = new BehaviorSubject<boolean>(false);
  public readonly skipNextSleepScheduleActive = this._skipNextSleepScheduleActive.asObservable();
  private currentAdvancedMode = false;

  constructor(
    private automationConfig: AutomationConfigService,
    private simpleBrightness: SimpleBrightnessControlService,
    private softwareBrightness: SoftwareBrightnessControlService,
    private hardwareBrightness: HardwareBrightnessControlService,
    private cctControl: CCTControlService,
    private audioDevices: AudioDeviceService,
    private eventLog: EventLogService,
    private researchLog: ResearchLogService
  ) {}

  async init() {
    this.automationConfig.configs.subscribe((configs) => {
      this.config = configs.SLEEP_WAKE_TRANSITIONS;
      this.currentAdvancedMode = configs.BRIGHTNESS_AUTOMATIONS.advancedMode;
    });

    merge(
      this.simpleBrightness.manualChange,
      this.softwareBrightness.manualChange,
      this.hardwareBrightness.manualChange
    ).subscribe((event) => {
      if (!event) return;
      this.onManualDomainIntervention('brightness');
    });
    this.cctControl.manualChange.subscribe((event) => {
      if (!event) return;
      this.onManualDomainIntervention('cct');
    });
    this.audioDevices.manualVolumeChange.subscribe((event) => {
      if (!event) return;
      this.onManualDomainIntervention('volume');
    });

    await listen('applySleepWakeTransitionManualSleep', async () => {
      await this.applyManualSleepTransition('user_overlay');
    });
    await listen('revertSleepWakeTransitionManualSleep', async () => {
      await this.revertManualSleepTransition('user_overlay');
    });
  }

  public get stateSync(): SleepWakeTransitionState {
    return this._state.value;
  }

  public get skipNextSleepScheduleSync(): boolean {
    return this.skipNextSleepSchedule;
  }

  public consumeSkipNextSleepSchedule() {
    const skip = this.skipNextSleepSchedule;
    this.skipNextSleepSchedule = false;
    this._skipNextSleepScheduleActive.next(false);
    return skip;
  }

  public clearSkipNextSleepSchedule() {
    // Debug-only escape hatch:
    // lets testers cancel the one-shot skip flag so near-future schedule checks
    // can be repeated without waiting for another manual sleep run.
    this.skipNextSleepSchedule = false;
    this._skipNextSleepScheduleActive.next(false);
  }

  public async applyManualSleepTransition(source: ResearchEventSource) {
    if (!this.config.enabled || !this.config.profiles.sleep.enabled) return;
    await this.cancelCurrentRun('MANUAL_OVERRIDE');
    this.skipNextSleepSchedule = true;
    this._skipNextSleepScheduleActive.next(true);
    const appliedDomains = this.toAppliedDomains(this.config.profiles.sleep.manualTarget);
    this.logStart('sleep', 'MANUAL', source);
    await this.applyTarget(
      this.config.profiles.sleep.manualTarget,
      'service',
      appliedDomains,
      undefined,
      'sleep',
      'MANUAL'
    );
    this._state.next({
      status: 'manual_applied',
      profile: 'sleep',
      appliedDomains,
      lastTrigger: 'manual',
    });
    this.logFinish('sleep', 'MANUAL', source);
  }

  public async revertManualSleepTransition(source: ResearchEventSource) {
    if (!this.config.enabled || !this.config.profiles.wake.enabled) return;
    await this.cancelCurrentRun('MANUAL_REVERT');
    const appliedDomains = this.toAppliedDomains(this.config.profiles.wake.manualTarget);
    this.logStart('wake', 'MANUAL', source);
    this._state.next({
      status: 'reverting',
      profile: 'wake',
      appliedDomains,
      lastTrigger: 'manual',
    });
    await this.applyTarget(
      this.config.profiles.wake.manualTarget,
      'service',
      appliedDomains,
      undefined,
      'wake',
      'MANUAL'
    );
    this._state.next(this.idleState());
    this.logFinish('wake', 'MANUAL', source);
  }

  public async startScheduledProfile(
    profile: SleepWakeTransitionProfileType,
    source: ResearchEventSource = 'automation'
  ) {
    if (!this.config.enabled || !this.config.profiles[profile].enabled) return;
    await this.cancelCurrentRun('SYSTEM');
    const profileConfig = this.config.profiles[profile];
    const run: RunContext = {
      profile,
      source,
      reason: 'SCHEDULED',
      timeoutIds: [],
      volumeTimeoutIds: [],
      domainLocks: this.toDomainsFromSteps(profileConfig.steps),
      cancelEndBehavior: false,
    };
    this.currentRun = run;
    this._state.next({
      status: 'scheduled_running',
      profile,
      appliedDomains: { ...run.domainLocks },
      lastTrigger: 'scheduled',
    });
    this.logStart(profile, 'SCHEDULED', source);

    for (const step of profileConfig.steps) {
      run.timeoutIds.push(
        setTimeout(() => {
          void this.applyStep(step, run);
        }, step.offsetMinutes * 60 * 1000)
      );
    }

    const finishDelay =
      profileConfig.steps.reduce((max, step) => {
        return Math.max(max, step.offsetMinutes * 60 * 1000 + step.transitionTimeMs);
      }, 0) + 100;
    run.timeoutIds.push(
      setTimeout(() => {
        void this.finishScheduledRun(run);
      }, finishDelay)
    );
  }

  public async cancelCurrentRun(
    reason: EventLogSleepWakeTransitionCancelled['reason'] = 'SYSTEM'
  ) {
    const run = this.currentRun;
    if (!run) return;
    this.clearRunTimers(run);
    this.cancelTransitions();
    this.currentRun = null;
    this._state.next({
      status: 'cancelled',
      profile: run.profile,
      appliedDomains: { ...run.domainLocks },
      lastTrigger: run.reason === 'MANUAL' ? 'manual' : 'scheduled',
    });
    this.logCancel(run.profile, reason, run.source);
    this._state.next(this.idleState());
  }

  private async applyStep(step: SleepWakeTransitionStep, run: RunContext) {
    if (this.currentRun !== run) return;
    await this.applyTarget(step, 'service', run.domainLocks, run, run.profile, run.reason);
    if (this.currentRun !== run) return;
    this._state.next({
      ...this._state.value,
      appliedDomains: { ...run.domainLocks },
    });
  }

  private async finishScheduledRun(run: RunContext) {
    if (this.currentRun !== run) return;
    this.currentRun = null;
    this.clearRunTimers(run);
    // PoC note:
    // Sleep / wake transitions intentionally stop at the environment change itself.
    // The actual Sleep mode ON/OFF handoff remains owned by the existing sleep detection
    // and enable/disable automations after the user really falls asleep or wakes up.
    run.cancelEndBehavior = true;
    this._state.next(this.idleState());
    this.logFinish(run.profile, 'SCHEDULED', run.source);
  }

  private async applyTarget(
    target: SleepWakeTransitionTarget,
    researchSource: ResearchEventSource,
    domainLocks?: TransitionDomainLocks,
    run?: RunContext,
    profile?: SleepWakeTransitionProfileType,
    reason?: 'MANUAL' | 'SCHEDULED'
  ) {
    const locks = domainLocks ?? this._state.value.appliedDomains;
    const transitionMs = Math.max(0, target.transitionTimeMs ?? 0);

    if (target.changeBrightness && locks.brightness) {
      if (profile && reason) {
        this.researchLog.rememberSleepWakeTransitionDomain('brightness', profile, reason);
      }
      const hardwareAvailable = await firstValueFrom(this.hardwareBrightness.driverIsAvailable);
      if (transitionMs > 0) {
        if (this.currentAdvancedMode) {
          this.softwareBrightness.transitionBrightness(target.softwareBrightness, transitionMs, {
            researchSource,
            logReason: null,
          });
          if (hardwareAvailable) {
            this.hardwareBrightness.transitionBrightness(target.hardwareBrightness, transitionMs, {
              researchSource,
              logReason: null,
            });
          }
        } else {
          this.simpleBrightness.transitionBrightness(target.brightness, transitionMs, {
            researchSource,
            logReason: null,
          });
        }
      } else if (this.currentAdvancedMode) {
        await this.softwareBrightness.setBrightness(target.softwareBrightness, {
          cancelActiveTransition: true,
          researchSource,
          logReason: null,
        });
        if (hardwareAvailable) {
          await this.hardwareBrightness.setBrightness(target.hardwareBrightness, {
            cancelActiveTransition: true,
            researchSource,
            logReason: null,
          });
        }
      } else {
        await this.simpleBrightness.setBrightness(target.brightness, {
          cancelActiveTransition: true,
          researchSource,
          logReason: null,
        });
      }
    }

    if (target.changeColorTemperature && locks.cct) {
      if (profile && reason) {
        this.researchLog.rememberSleepWakeTransitionDomain('color_temperature', profile, reason);
      }
      if (transitionMs > 0) {
        this.cctControl.transitionCCT(target.colorTemperature, transitionMs, {
          researchSource,
          logReason: null,
        });
      } else {
        await this.cctControl.setCCT(target.colorTemperature, {
          cancelActiveTransition: true,
          researchSource,
          logReason: null,
        });
      }
    }

    if (target.changeVolume && locks.volume && target.volume !== null) {
      if (profile && reason) {
        this.researchLog.rememberSleepWakeTransitionDomain('volume', profile, reason);
      }
      await this.applyVolumeTarget(target.volume, transitionMs, researchSource, run);
    }
  }

  private async applyVolumeTarget(
    volumePercent: number,
    transitionMs: number,
    source: ResearchEventSource,
    run?: RunContext
  ) {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) return;
    if (!transitionMs) {
      await this.audioDevices.setVolume(device.id, volumePercent / 100, source);
      return;
    }
    const startVolume = Math.round((device.volume ?? 1) * 100);
    const stepCount = Math.max(1, Math.min(20, Math.floor(transitionMs / 500)));
    const stepDelay = transitionMs / stepCount;
    const timeoutIds = run?.volumeTimeoutIds ?? [];
    for (let i = 1; i <= stepCount; i++) {
      const nextVolume = startVolume + ((volumePercent - startVolume) * i) / stepCount;
      timeoutIds.push(
        setTimeout(() => {
          void this.audioDevices.setVolume(device.id, nextVolume / 100, source);
        }, Math.round(stepDelay * i))
      );
    }
  }

  private onManualDomainIntervention(domain: keyof TransitionDomainLocks) {
    const run = this.currentRun;
    if (run) {
      run.domainLocks[domain] = false;
      run.cancelEndBehavior = true;
      if (domain === 'brightness') {
        this.simpleBrightness.cancelActiveTransition();
        this.softwareBrightness.cancelActiveTransition();
        this.hardwareBrightness.cancelActiveTransition();
      } else if (domain === 'cct') {
        this.cctControl.cancelActiveTransition();
      } else {
        run.volumeTimeoutIds.forEach((timeoutId) => clearTimeout(timeoutId));
        run.volumeTimeoutIds = [];
      }
      this._state.next({
        ...this._state.value,
        appliedDomains: { ...run.domainLocks },
      });
      if (!Object.values(run.domainLocks).some(Boolean)) {
        void this.cancelCurrentRun('USER_INTERVENTION');
      }
      return;
    }

    if (this._state.value.status !== 'manual_applied') return;
    const appliedDomains = {
      ...this._state.value.appliedDomains,
      [domain]: false,
    };
    if (!Object.values(appliedDomains).some(Boolean)) {
      this._state.next(this.idleState());
      return;
    }
    this._state.next({
      ...this._state.value,
      appliedDomains,
    });
  }

  private cancelTransitions() {
    this.simpleBrightness.cancelActiveTransition();
    this.softwareBrightness.cancelActiveTransition();
    this.hardwareBrightness.cancelActiveTransition();
    this.cctControl.cancelActiveTransition();
  }

  private clearRunTimers(run: RunContext) {
    run.timeoutIds.forEach((timeoutId) => clearTimeout(timeoutId));
    run.volumeTimeoutIds.forEach((timeoutId) => clearTimeout(timeoutId));
    run.timeoutIds = [];
    run.volumeTimeoutIds = [];
  }

  private idleState(): SleepWakeTransitionState {
    return {
      status: 'idle',
      profile: null,
      appliedDomains: { brightness: false, cct: false, volume: false },
      lastTrigger: null,
    };
  }

  private toAppliedDomains(target: SleepWakeTransitionTarget): TransitionDomainLocks {
    return {
      brightness: target.changeBrightness,
      cct: target.changeColorTemperature,
      volume: target.changeVolume,
    };
  }

  private toDomainsFromSteps(steps: SleepWakeTransitionStep[]): TransitionDomainLocks {
    return steps.reduce<TransitionDomainLocks>(
      (domains, step) => ({
        brightness: domains.brightness || step.changeBrightness,
        cct: domains.cct || step.changeColorTemperature,
        volume: domains.volume || step.changeVolume,
      }),
      { brightness: false, cct: false, volume: false }
    );
  }

  private logStart(
    profile: SleepWakeTransitionProfileType,
    reason: EventLogSleepWakeTransitionStarted['reason'],
    source: ResearchEventSource
  ) {
    this.eventLog.logEvent({
      type: 'sleepWakeTransitionStarted',
      profile,
      reason,
    } as EventLogSleepWakeTransitionStarted);
    this.researchLog.logSleepWakeTransitionStarted(profile, source, {
      reason,
    });
  }

  private logFinish(
    profile: SleepWakeTransitionProfileType,
    reason: EventLogSleepWakeTransitionFinished['reason'],
    source: ResearchEventSource
  ) {
    this.eventLog.logEvent({
      type: 'sleepWakeTransitionFinished',
      profile,
      reason,
    } as EventLogSleepWakeTransitionFinished);
    this.researchLog.logSleepWakeTransitionFinished(profile, source, {
      reason,
    });
  }

  private logCancel(
    profile: SleepWakeTransitionProfileType,
    reason: EventLogSleepWakeTransitionCancelled['reason'],
    source: ResearchEventSource
  ) {
    this.eventLog.logEvent({
      type: 'sleepWakeTransitionCancelled',
      profile,
      reason,
    } as EventLogSleepWakeTransitionCancelled);
    this.researchLog.logSleepWakeTransitionCancelled(profile, source, {
      reason,
    });
  }
}
