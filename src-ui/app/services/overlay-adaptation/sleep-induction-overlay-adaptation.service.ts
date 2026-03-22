import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AutomationConfigService } from '../automation-config.service';
import { clamp, smoothLerp } from '../../utils/number-utils';
import { SoftwareBrightnessControlService } from '../brightness-control/software-brightness-control.service';

const APPLY_INTERVAL_MS = 100;
const DEBUG_ENVIRONMENT_LUMINANCE_DEFAULT = 0.18;
const ENVIRONMENT_LUMINANCE_REFERENCE = 0.18;
const ADAPTATION_GAIN = 0.45;
const ADAPTATION_MIN_ALPHA = 0;
const ADAPTATION_MAX_ALPHA = 0.12;
const TOTAL_MIN_ALPHA = 0;
const TOTAL_MAX_ALPHA = 0.98;
const SETTLED_PHASE_START_PROGRESS = 0.9;
const MIDDLE_PHASE_START_PROGRESS = 0.3;
const EPSILON = 0.0001;
const APPLY_ALPHA_EPSILON = 0.001;

type AdaptationPhase = 'idle' | 'early' | 'middle' | 'settled';

interface ActiveRun {
  startedAt: number;
  durationMs: number;
  startAlpha: number;
  endAlpha: number;
}

export interface SleepInductionOverlayAdaptationDebugState {
  active: boolean;
  advancedModeEnabled: boolean;
  progress: number;
  phase: AdaptationPhase;
  debugEnvironmentLuminance: number;
  debugObservationReliable: boolean;
  alphaSchedule: number;
  alphaAdapt: number;
  alphaAdaptTarget: number;
  alphaTotal: number;
  estimatedEnvironmentLuminance: number;
  effectiveSoftwareBrightness: number;
}

const DEFAULT_DEBUG_STATE: SleepInductionOverlayAdaptationDebugState = {
  active: false,
  advancedModeEnabled: false,
  progress: 0,
  phase: 'idle',
  debugEnvironmentLuminance: DEBUG_ENVIRONMENT_LUMINANCE_DEFAULT,
  debugObservationReliable: true,
  alphaSchedule: 0,
  alphaAdapt: 0,
  alphaAdaptTarget: 0,
  alphaTotal: 0,
  estimatedEnvironmentLuminance: DEBUG_ENVIRONMENT_LUMINANCE_DEFAULT,
  effectiveSoftwareBrightness: 100,
};

@Injectable({
  providedIn: 'root',
})
export class SleepInductionOverlayAdaptationService {
  private activeRun: ActiveRun | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private advancedModeEnabled = false;
  private alphaAdapt = 0;
  private alphaAdaptTarget = 0;
  private alphaTotal = 0;
  private lastTickAt = 0;
  private lastAppliedAlpha = -1;
  private debugEnvironmentLuminance = DEBUG_ENVIRONMENT_LUMINANCE_DEFAULT;
  private debugObservationReliable = true;
  private readonly _debugState = new BehaviorSubject<SleepInductionOverlayAdaptationDebugState>({
    ...DEFAULT_DEBUG_STATE,
  });

  public readonly debugState = this._debugState.asObservable();

  constructor(
    private automationConfig: AutomationConfigService,
    private softwareBrightness: SoftwareBrightnessControlService
  ) {}

  async init() {
    this.automationConfig.configs.subscribe((configs) => {
      this.advancedModeEnabled = configs.BRIGHTNESS_AUTOMATIONS.advancedMode;
      this.patchDebugState({
        advancedModeEnabled: this.advancedModeEnabled,
      });
    });
  }

  get activeSync() {
    return !!this.activeRun;
  }

  get debugStateSync() {
    return this._debugState.value;
  }

  public canManageSleepInduction() {
    return this.advancedModeEnabled;
  }

  public async startSleepInduction(transitionMs: number, targetSoftwareBrightnessPercent: number) {
    if (!this.canManageSleepInduction()) return false;
    await this.stop();
    const startAlpha = this.brightnessPercentToAlpha(this.softwareBrightness.brightness);
    const endAlpha = this.brightnessPercentToAlpha(targetSoftwareBrightnessPercent);
    this.activeRun = {
      startedAt: Date.now(),
      durationMs: Math.max(0, Math.round(transitionMs)),
      startAlpha,
      endAlpha,
    };
    this.alphaAdapt = 0;
    this.alphaAdaptTarget = 0;
    this.alphaTotal = startAlpha;
    this.lastAppliedAlpha = -1;
    this.lastTickAt = 0;
    this.patchDebugState({
      active: true,
      progress: 0,
      phase: this.resolvePhase(0),
      alphaSchedule: startAlpha,
      alphaAdapt: this.alphaAdapt,
      alphaAdaptTarget: this.alphaAdaptTarget,
      alphaTotal: this.alphaTotal,
      estimatedEnvironmentLuminance: this.debugEnvironmentLuminance,
      effectiveSoftwareBrightness: this.alphaToBrightnessPercent(this.alphaTotal),
    });
    await this.runTick();
    return true;
  }

  public async stop() {
    this.activeRun = null;
    this.clearTimer();
    this.alphaAdapt = 0;
    this.alphaAdaptTarget = 0;
    this.alphaTotal = 0;
    this.lastTickAt = 0;
    this.lastAppliedAlpha = -1;
    this.patchDebugState({
      active: false,
      progress: 0,
      phase: 'idle',
      alphaSchedule: 0,
      alphaAdapt: 0,
      alphaAdaptTarget: 0,
      alphaTotal: 0,
      estimatedEnvironmentLuminance: this.debugEnvironmentLuminance,
      effectiveSoftwareBrightness: this.softwareBrightness.brightness,
    });
  }

  public async setDebugEnvironmentLuminance(value: number) {
    this.debugEnvironmentLuminance = clamp(value, 0, 1);
    this.patchDebugState({
      debugEnvironmentLuminance: this.debugEnvironmentLuminance,
    });
    if (this.activeRun) {
      await this.runTick();
    }
  }

  public async setDebugObservationReliable(reliable: boolean) {
    this.debugObservationReliable = reliable;
    this.patchDebugState({
      debugObservationReliable: reliable,
    });
    if (this.activeRun) {
      await this.runTick();
    }
  }

  private async runTick() {
    if (!this.activeRun) return;
    const now = Date.now();
    const dtSeconds = this.lastTickAt ? (now - this.lastTickAt) / 1000 : APPLY_INTERVAL_MS / 1000;
    this.lastTickAt = now;

    const progress =
      this.activeRun.durationMs <= 0
        ? 1
        : clamp((now - this.activeRun.startedAt) / this.activeRun.durationMs, 0, 1);
    const phase = this.resolvePhase(progress);
    const alphaSchedule = smoothLerp(this.activeRun.startAlpha, this.activeRun.endAlpha, progress);
    const estimatedEnvironmentLuminance = this.estimateEnvironmentLuminance(alphaSchedule);
    if (this.debugObservationReliable) {
      this.alphaAdaptTarget = clamp(
        (estimatedEnvironmentLuminance - ENVIRONMENT_LUMINANCE_REFERENCE) * ADAPTATION_GAIN,
        ADAPTATION_MIN_ALPHA,
        ADAPTATION_MAX_ALPHA
      );
    }
    const { up, down } = this.getPhaseRates(phase);
    const delta = clamp(
      this.alphaAdaptTarget - this.alphaAdapt,
      -down * dtSeconds,
      up * dtSeconds
    );
    this.alphaAdapt = clamp(
      this.alphaAdapt + delta,
      ADAPTATION_MIN_ALPHA,
      ADAPTATION_MAX_ALPHA
    );
    this.alphaTotal = clamp(alphaSchedule + this.alphaAdapt, TOTAL_MIN_ALPHA, TOTAL_MAX_ALPHA);
    await this.applyAlpha(this.alphaTotal);
    this.patchDebugState({
      active: true,
      progress,
      phase,
      alphaSchedule,
      alphaAdapt: this.alphaAdapt,
      alphaAdaptTarget: this.alphaAdaptTarget,
      alphaTotal: this.alphaTotal,
      estimatedEnvironmentLuminance,
      effectiveSoftwareBrightness: this.alphaToBrightnessPercent(this.alphaTotal),
    });
    this.scheduleNextTick();
  }

  private scheduleNextTick() {
    this.clearTimer();
    this.tickTimer = setTimeout(() => {
      void this.runTick();
    }, APPLY_INTERVAL_MS);
  }

  private clearTimer() {
    if (!this.tickTimer) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  private async applyAlpha(alpha: number) {
    if (Math.abs(alpha - this.lastAppliedAlpha) < APPLY_ALPHA_EPSILON) return;
    this.lastAppliedAlpha = alpha;
    await this.softwareBrightness.setBrightness(this.alphaToBrightnessPercent(alpha), {
      cancelActiveTransition: true,
      logReason: null,
      researchSource: 'service',
      logResearchEvent: false,
    });
  }

  private estimateEnvironmentLuminance(alphaSchedule: number) {
    const observed = this.debugEnvironmentLuminance;
    const divisor = Math.max(1 - clamp(alphaSchedule + this.alphaAdapt, 0, 1), EPSILON);
    return clamp(observed / divisor, 0, 1);
  }

  private resolvePhase(progress: number): AdaptationPhase {
    if (!this.activeRun) return 'idle';
    if (progress >= SETTLED_PHASE_START_PROGRESS) return 'settled';
    if (progress >= MIDDLE_PHASE_START_PROGRESS) return 'middle';
    return 'early';
  }

  private getPhaseRates(phase: AdaptationPhase) {
    switch (phase) {
      case 'early':
        return { up: 0.03, down: 0.01 };
      case 'middle':
        return { up: 0.02, down: 0 };
      case 'settled':
        return { up: 0.008, down: 0.004 };
      case 'idle':
      default:
        return { up: 0, down: 0 };
    }
  }

  private brightnessPercentToAlpha(percentage: number) {
    return clamp(1 - percentage / 100, 0, 1);
  }

  private alphaToBrightnessPercent(alpha: number) {
    return clamp((1 - alpha) * 100, 0, 100);
  }

  private patchDebugState(
    patch: Partial<SleepInductionOverlayAdaptationDebugState>
  ) {
    this._debugState.next({
      ...this._debugState.value,
      ...patch,
    });
  }
}
