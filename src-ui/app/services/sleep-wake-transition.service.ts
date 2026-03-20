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

export interface SleepWakeRelativeVolumeState {
  enabled: boolean;
  baselineKnown: boolean;
  deviceId: string | null;
  relativePercent: number;
  transitioning: boolean;
  transitionTarget: number;
}

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
  activeState: SleepWakeTransitionState;
  completionState: SleepWakeTransitionState;
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
  private readonly _relativeVolumeState = new BehaviorSubject<SleepWakeRelativeVolumeState>({
    enabled: false,
    baselineKnown: false,
    deviceId: null,
    relativePercent: 100,
    transitioning: false,
    transitionTarget: 100,
  });
  public readonly relativeVolumeState = this._relativeVolumeState.asObservable();

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
      const previousDeviceId = this.getCurrentAudioDeviceId();
      this.config = configs.SLEEP_WAKE_TRANSITIONS;
      this.currentAdvancedMode = configs.BRIGHTNESS_AUTOMATIONS.advancedMode;
      this.syncRelativeVolumeState(previousDeviceId !== this.getCurrentAudioDeviceId());
    });
    this.audioDevices.activeDevices.subscribe(() => {
      this.syncRelativeVolumeState();
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
    await listen<number>('setRelativeSleepWakeVolume', async (event) => {
      await this.setRelativeVolumePercent(event.payload, 'user_overlay');
    });
  }

  public get stateSync(): SleepWakeTransitionState {
    return this._state.value;
  }

  public get skipNextSleepScheduleSync(): boolean {
    return this.skipNextSleepSchedule;
  }

  public get relativeVolumeStateSync(): SleepWakeRelativeVolumeState {
    return this._relativeVolumeState.value;
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

  public async setRelativeVolumePercent(
    relativePercent: number,
    source: ResearchEventSource = 'unknown'
  ) {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) {
      this.syncRelativeVolumeState();
      return;
    }
    const baseline = this.getOrCreateVolumeBaseline(device.id, device.volume);
    if (!baseline) return;

    const clampedRelativePercent = Math.max(0, Math.min(100, Math.round(relativePercent)));
    const targetVolumePercent = Math.max(
      0,
      Math.min(100, (baseline.volumePercent * clampedRelativePercent) / 100)
    );

    this._relativeVolumeState.next({
      enabled: true,
      baselineKnown: true,
      deviceId: device.id,
      relativePercent: clampedRelativePercent,
      transitioning: false,
      transitionTarget: clampedRelativePercent,
    });
    await this.audioDevices.setVolume(device.id, targetVolumePercent / 100, source);
  }

  public async applyManualSleepTransition(source: ResearchEventSource) {
    if (!this.config.enabled || !this.config.profiles.sleep.enabled) return;
    await this.cancelCurrentRun('MANUAL_OVERRIDE');
    this.captureVolumeBaseline();
    this.skipNextSleepSchedule = true;
    this._skipNextSleepScheduleActive.next(true);
    const appliedDomains = this.toAppliedDomains('sleep', this.config.profiles.sleep.manualTarget);
    const run = this.createRunContext('sleep', source, 'MANUAL', appliedDomains, {
      status: 'manual_applied',
      profile: 'sleep',
      appliedDomains,
      lastTrigger: 'manual',
    });
    this.currentRun = run;
    this._state.next(run.activeState);
    this.logStart(run.profile, run.reason, run.source);
    const transitionMs = this.getTransitionTimeMs('sleep', 'MANUAL');
    await this.applyTarget(
      this.config.profiles.sleep.manualTarget,
      transitionMs,
      'service',
      appliedDomains,
      run,
      run.profile,
      run.reason
    );
    if (this.currentRun !== run) return;
    run.timeoutIds.push(
      setTimeout(() => {
        void this.finishRun(run);
      }, Math.max(100, transitionMs + 100))
    );
  }

  public async revertManualSleepTransition(source: ResearchEventSource) {
    if (!this.config.enabled || !this.config.profiles.wake.enabled) return;
    await this.cancelCurrentRun('MANUAL_REVERT');
    const appliedDomains = this.toAppliedDomains('wake', this.config.profiles.wake.manualTarget);
    const run = this.createRunContext('wake', source, 'MANUAL', appliedDomains, this.idleState(), {
      status: 'reverting',
      profile: 'wake',
      appliedDomains,
      lastTrigger: 'manual',
    });
    this.currentRun = run;
    this._state.next(run.activeState);
    this.logStart(run.profile, run.reason, run.source);
    const transitionMs = this.getTransitionTimeMs('wake', 'MANUAL');
    await this.applyTarget(
      this.config.profiles.wake.manualTarget,
      transitionMs,
      'service',
      appliedDomains,
      run,
      run.profile,
      run.reason
    );
    if (this.currentRun !== run) return;
    run.timeoutIds.push(
      setTimeout(() => {
        void this.finishRun(run);
      }, Math.max(100, transitionMs + 100))
    );
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
      activeState: {
        status: 'scheduled_running',
        profile,
        appliedDomains: this.toAppliedDomains(profile, target),
        lastTrigger: 'scheduled',
      },
      completionState: this.idleState(),
    };
    this.currentRun = run;
    this._state.next(run.activeState);
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
        void this.finishRun(run);
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
    this.setVolumeTransitionState(false);
    this.logCancel(run.profile, reason, run.source);
    this._state.next(this.idleState());
  }

  private async finishRun(run: RunContext) {
    if (this.currentRun !== run) return;
    this.currentRun = null;
    this.clearRunTimers(run);
    // PoC note:
    // Sleep / wake transitions intentionally stop at the environment change itself.
    // The actual Sleep mode ON/OFF handoff remains owned by the existing sleep detection
    // and enable/disable automations after the user really falls asleep or wakes up.
    this.setVolumeTransitionState(false);
    this._state.next(run.completionState);
    this.logFinish(run.profile, run.reason, run.source);
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
      this.updateRelativeVolumePercentForActual(device.id, volumePercent);
      this.setVolumeTransitionState(false, this.getRelativePercentForActual(device.id, volumePercent));
      await this.audioDevices.setVolume(device.id, volumePercent / 100, source);
      return;
    }
    const startVolume = Math.round((device.volume ?? 1) * 100);
    const stepCount = Math.max(1, Math.min(20, Math.floor(transitionMs / 500)));
    const stepDelay = transitionMs / stepCount;
    const timeoutIds = run?.volumeTimeoutIds ?? [];
    const targetRelativePercent = this.getRelativePercentForActual(device.id, volumePercent);
    this.setVolumeTransitionState(true, targetRelativePercent);
    for (let i = 1; i <= stepCount; i++) {
      const nextVolume = startVolume + ((volumePercent - startVolume) * i) / stepCount;
      timeoutIds.push(
        setTimeout(() => {
          this.updateRelativeVolumePercentForActual(device.id, nextVolume);
          void this.audioDevices.setVolume(device.id, nextVolume / 100, source);
        }, Math.round(stepDelay * i))
      );
    }
    timeoutIds.push(
      setTimeout(() => {
        this.setVolumeTransitionState(false, targetRelativePercent);
      }, Math.max(100, transitionMs + 25))
    );
  }

  private onManualDomainIntervention(domain: keyof TransitionDomainLocks) {
    const run = this.currentRun;
    if (run) {
      // UX decision:
      // once the user manually intervenes in any wake/sleep transition domain,
      // stop the entire transition run instead of only disabling that single domain.
      // This keeps the system from continuing to "fight" the user's intent.
      void this.cancelCurrentRun('USER_INTERVENTION');
      return;
    }

    if (!['manual_applied', 'reverting'].includes(this._state.value.status)) return;
    // Safety fallback for any stray manual state that somehow exists without an active run.
    // In normal operation manual transitions should always have currentRun set now.
    this.cancelTransitions();
    this.setVolumeTransitionState(false);
    this._state.next(this.idleState());
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

  private createRunContext(
    profile: SleepWakeTransitionProfileType,
    source: ResearchEventSource,
    reason: 'MANUAL' | 'SCHEDULED',
    domainLocks: TransitionDomainLocks,
    completionState: SleepWakeTransitionState,
    activeState?: SleepWakeTransitionState
  ): RunContext {
    return {
      profile,
      source,
      reason,
      timeoutIds: [],
      volumeTimeoutIds: [],
      domainLocks,
      activeState:
        activeState ?? {
          status: 'scheduled_running',
          profile,
          appliedDomains: { ...domainLocks },
          lastTrigger: reason === 'MANUAL' ? 'manual' : 'scheduled',
        },
      completionState,
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
      // Keep the baseline in raw percent precision so the UI can show an exact
      // 100% when it is first captured, instead of drifting to 99% due to rounding.
      volumePercent: (device.volume ?? 1) * 100,
    };
    this._relativeVolumeState.next({
      enabled: true,
      baselineKnown: true,
      deviceId: device.id,
      relativePercent: 100,
      transitioning: false,
      transitionTarget: 100,
    });
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

  private syncRelativeVolumeState(forceRebaseline = false) {
    const device = this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId);
    if (!device) {
      this._relativeVolumeState.next({
        enabled: false,
        baselineKnown: false,
        deviceId: null,
        relativePercent: 100,
        transitioning: false,
        transitionTarget: 100,
      });
      this.volumeBaseline = null;
      return;
    }

    const baseline = this.getOrCreateVolumeBaseline(
      device.id,
      device.volume,
      forceRebaseline || this.volumeBaseline?.deviceId !== device.id
    );
    const relativePercent =
      baseline && baseline.volumePercent > 0
        ? Math.max(0, Math.min(100, Math.round(((device.volume ?? 1) * 100 * 100) / baseline.volumePercent)))
        : 100;

    this._relativeVolumeState.next({
      enabled: true,
      baselineKnown: !!baseline,
      deviceId: device.id,
      relativePercent,
      transitioning: this._relativeVolumeState.value.transitioning,
      transitionTarget: this._relativeVolumeState.value.transitionTarget,
    });
  }

  private getOrCreateVolumeBaseline(
    deviceId: string,
    currentDeviceVolume?: number,
    forceReset = false
  ) {
    if (!forceReset && this.volumeBaseline && this.volumeBaseline.deviceId === deviceId) {
      return this.volumeBaseline;
    }

    this.volumeBaseline = {
      deviceId,
      // Preserve precision here for the same reason as captureVolumeBaseline():
      // relative UI should treat the captured/current device volume as a true 100% baseline.
      volumePercent: (currentDeviceVolume ?? 1) * 100,
    };
    return this.volumeBaseline;
  }

  private updateRelativeVolumePercentForActual(deviceId: string, actualVolumePercent: number) {
    const baseline = this.getOrCreateVolumeBaseline(deviceId);
    if (!baseline || baseline.volumePercent <= 0) return;
    this._relativeVolumeState.next({
      enabled: true,
      baselineKnown: true,
      deviceId,
      relativePercent: Math.max(
        0,
        Math.min(100, Math.round((actualVolumePercent * 100) / baseline.volumePercent))
      ),
      transitioning: this._relativeVolumeState.value.transitioning,
      transitionTarget: this._relativeVolumeState.value.transitionTarget,
    });
  }

  private getRelativePercentForActual(deviceId: string, actualVolumePercent: number) {
    const baseline = this.getOrCreateVolumeBaseline(deviceId);
    if (!baseline || baseline.volumePercent <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round((actualVolumePercent * 100) / baseline.volumePercent)));
  }

  private setVolumeTransitionState(transitioning: boolean, transitionTarget?: number) {
    const currentState = this._relativeVolumeState.value;
    this._relativeVolumeState.next({
      ...currentState,
      transitioning,
      transitionTarget: transitionTarget ?? currentState.transitionTarget,
    });
  }

  private getCurrentAudioDeviceId() {
    return this.audioDevices.getAudioDeviceForPersistentId(this.config.audioDevicePersistentId)?.id ?? null;
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
