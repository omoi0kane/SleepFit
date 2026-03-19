import { Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { BehaviorSubject, firstValueFrom, merge } from 'rxjs';
import {
  AUTOMATION_CONFIGS_DEFAULT,
  SleepWakeScheduledCurveMode,
  SleepWakeTransitionProfileType,
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

type VolumeBaseline = {
  deviceId: string;
  volumePercent: number;
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
};

@Injectable({
  providedIn: 'root',
})
export class SleepWakeTransitionService {
  private static readonly WAKE_EVIDENCE_VOLUME_DURATION_RATIO = 0.15;
  private static readonly WAKE_EVIDENCE_MIN_VOLUME_DURATION_MS = 10000;

  private config: SleepWakeTransitionsConfig = structuredClone(
    AUTOMATION_CONFIGS_DEFAULT.SLEEP_WAKE_TRANSITIONS
  );
  private readonly _state = new BehaviorSubject<SleepWakeTransitionState>(this.idleState());
  public readonly state = this._state.asObservable();

  private currentRun: RunContext | null = null;
  private skipNextSleepSchedule = false;
  // Debug-only UI support:
  // expose whether the next scheduled sleep run will be skipped so testers can
  // intentionally clear it without restarting the app during short schedule tests.
  private readonly _skipNextSleepScheduleActive = new BehaviorSubject<boolean>(false);
  public readonly skipNextSleepScheduleActive = this._skipNextSleepScheduleActive.asObservable();
  private currentAdvancedMode = false;
  private volumeBaseline: VolumeBaseline | null = null;

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
    this.captureVolumeBaseline();
    this.skipNextSleepSchedule = true;
    this._skipNextSleepScheduleActive.next(true);
    const appliedDomains = this.toAppliedDomains('sleep', this.config.profiles.sleep.manualTarget);
    this.logStart('sleep', 'MANUAL', source);
    const transitionMs = this.getTransitionTimeMs('sleep', 'MANUAL');
    await this.applyTarget(
      this.config.profiles.sleep.manualTarget,
      transitionMs,
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
    const appliedDomains = this.toAppliedDomains('wake', this.config.profiles.wake.manualTarget);
    this.logStart('wake', 'MANUAL', source);
    this._state.next({
      status: 'reverting',
      profile: 'wake',
      appliedDomains,
      lastTrigger: 'manual',
    });
    await this.applyTarget(
      this.config.profiles.wake.manualTarget,
      this.getTransitionTimeMs('wake', 'MANUAL'),
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
    if (profile === 'sleep') {
      this.captureVolumeBaseline();
    }
    const target = this.config.profiles[profile].manualTarget;
    const run: RunContext = {
      profile,
      source,
      reason: 'SCHEDULED',
      timeoutIds: [],
      volumeTimeoutIds: [],
      domainLocks: this.toAppliedDomains(profile, target),
    };
    this.currentRun = run;
    this._state.next({
      status: 'scheduled_running',
      profile,
      appliedDomains: { ...run.domainLocks },
      lastTrigger: 'scheduled',
    });
    this.logStart(profile, 'SCHEDULED', source);

    const transitionMs = this.getTransitionTimeMs(profile, 'SCHEDULED');
    if (profile === 'wake' && this.getScheduledCurveMode(profile) === 'EVIDENCE_BASED') {
      await this.startEvidenceBasedWakeRun(target, transitionMs, run);
    } else {
      await this.applyTarget(
        target,
        transitionMs,
        'service',
        run.domainLocks,
        run,
        profile,
        run.reason
      );
    }
    if (this.currentRun !== run) return;

    run.timeoutIds.push(
      setTimeout(() => {
        void this.finishScheduledRun(run);
      }, Math.max(100, transitionMs + 100))
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

  private async finishScheduledRun(run: RunContext) {
    if (this.currentRun !== run) return;
    this.currentRun = null;
    this.clearRunTimers(run);
    // PoC note:
    // Sleep / wake transitions intentionally stop at the environment change itself.
    // The actual Sleep mode ON/OFF handoff remains owned by the existing sleep detection
    // and enable/disable automations after the user really falls asleep or wakes up.
    this._state.next(this.idleState());
    this.logFinish(run.profile, 'SCHEDULED', run.source);
  }

  private async applyTarget(
    target: SleepWakeTransitionTarget,
    transitionMs: number,
    researchSource: ResearchEventSource,
    domainLocks?: TransitionDomainLocks,
    run?: RunContext,
    profile?: SleepWakeTransitionProfileType,
    reason?: 'MANUAL' | 'SCHEDULED',
    skipVolume = false
  ) {
    const locks = domainLocks ?? this._state.value.appliedDomains;

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

    if (!skipVolume && locks.volume && profile) {
      const targetVolumePercent = this.resolveVolumeTargetPercent(profile, target);
      if (targetVolumePercent !== null) {
        if (reason) {
          this.researchLog.rememberSleepWakeTransitionDomain('volume', profile, reason);
        }
        await this.applyVolumeTarget(targetVolumePercent, transitionMs, researchSource, run);
      }
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

  private toAppliedDomains(
    profile: SleepWakeTransitionProfileType,
    target: SleepWakeTransitionTarget
  ): TransitionDomainLocks {
    return {
      brightness: target.changeBrightness,
      cct: target.changeColorTemperature,
      volume: this.hasActiveVolumeTarget(profile, target),
    };
  }

  private hasActiveVolumeTarget(
    profile: SleepWakeTransitionProfileType,
    target: SleepWakeTransitionTarget
  ) {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) return false;
    if (profile === 'sleep') {
      return target.changeVolume && target.volume !== null;
    }
    return !!this.volumeBaseline && this.volumeBaseline.deviceId === device.id;
  }

  private captureVolumeBaseline() {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) return;
    // UX note:
    // wake-side volume is intentionally not user-configurable anymore.
    // Instead we restore to the volume that was active when the sleep transition started.
    this.volumeBaseline = {
      deviceId: device.id,
      volumePercent: Math.round((device.volume ?? 1) * 100),
    };
  }

  private resolveVolumeTargetPercent(
    profile: SleepWakeTransitionProfileType,
    target: SleepWakeTransitionTarget
  ) {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) return null;

    if (profile === 'sleep') {
      if (!target.changeVolume || target.volume === null || !this.volumeBaseline) return null;
      return Math.max(0, Math.min(100, (this.volumeBaseline.volumePercent * target.volume) / 100));
    }

    // Compatibility note:
    // wake manualTarget.volume is still present in the stored model so old configs load cleanly,
    // but the wake UI and execution intentionally ignore it. Wake restores to the captured
    // pre-sleep baseline instead of using a separate absolute target.
    if (!this.volumeBaseline || this.volumeBaseline.deviceId !== device.id) return null;
    return this.volumeBaseline.volumePercent;
  }

  private async startEvidenceBasedWakeRun(
    target: SleepWakeTransitionTarget,
    transitionMs: number,
    run: RunContext
  ) {
    // Research-oriented scheduled wake variant:
    // keep brightness / color temperature on the existing shared path, but delay
    // the wake volume restoration until the end of the wake window.
    await this.applyTarget(
      target,
      transitionMs,
      'service',
      run.domainLocks,
      run,
      run.profile,
      run.reason,
      true
    );

    if (!run.domainLocks.volume) return;
    const targetVolumePercent = this.resolveVolumeTargetPercent(run.profile, target);
    if (targetVolumePercent === null) return;

    const volumeDurationMs = Math.min(
      transitionMs,
      Math.max(
        SleepWakeTransitionService.WAKE_EVIDENCE_MIN_VOLUME_DURATION_MS,
        Math.round(
          transitionMs * SleepWakeTransitionService.WAKE_EVIDENCE_VOLUME_DURATION_RATIO
        )
      )
    );
    const volumeDelayMs = Math.max(0, transitionMs - volumeDurationMs);

    run.timeoutIds.push(
      setTimeout(() => {
        if (this.currentRun !== run || !run.domainLocks.volume) return;
        this.researchLog.rememberSleepWakeTransitionDomain('volume', run.profile, run.reason);
        void this.applyVolumeTarget(targetVolumePercent, volumeDurationMs, 'service', run);
      }, volumeDelayMs)
    );
  }

  private getTransitionTimeMs(
    profile: SleepWakeTransitionProfileType,
    reason: 'MANUAL' | 'SCHEDULED'
  ) {
    const config = this.config.profiles[profile];
    const configuredTime =
      reason === 'MANUAL' ? config.manualTransitionTimeMs : config.scheduledTransitionTimeMs;
    // Compatibility fallback:
    // older saved configs only have manualTarget.transitionTimeMs, so we keep
    // reading it until the user saves the new split-duration fields.
    return Math.max(0, configuredTime ?? config.manualTarget.transitionTimeMs ?? 0);
  }

  private getScheduledCurveMode(profile: SleepWakeTransitionProfileType): SleepWakeScheduledCurveMode {
    return this.config.profiles[profile].scheduledCurveMode ?? 'CLASSIC';
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
