import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BehaviorSubject } from 'rxjs';
import { OpenVRService } from '../openvr.service';
import { clamp, smoothLerp } from '../../utils/number-utils';

const WAKE_OVERLAY_ON_RATIO = 0.4;
const WAKE_OVERLAY_HOLD_RATIO = 0.6;
// Intentionally allow the wake overlay envelope to outlast the scheduled wake transition.
// This keeps the pseudo-daylight effect active even after brightness has already reached
// its wake target, which makes the overlay materially noticeable during the wake window.
const WAKE_OVERLAY_OFF_RATIO = 0.3;
const WAKE_OVERLAY_INTERRUPT_FADE_OUT_MS = 10_000;
const WAKE_OVERLAY_FRAME_INTERVAL_MS = 1000 / 30;

type WakeOverlayMode = 'scheduled' | 'fade_out' | 'debug_preview';

export interface WakeOverlayDebugConfig {
  hmdProfile: string;
  axisScaleX: number;
  axisScaleY: number;
  innerRadius: number;
  outerRadius: number;
  maxOpacity: number;
  baseOpacity: number;
  accentOpacity: number;
  shape: number;
  accentShape: number;
  centerFloor: number;
  colorR: number;
  colorG: number;
  colorB: number;
}

const DEFAULT_WAKE_OVERLAY_CONFIG: WakeOverlayDebugConfig = {
  hmdProfile: 'Quest 3',
  axisScaleX: 1,
  axisScaleY: 1,
  innerRadius: 0.25,
  outerRadius: 0.95,
  maxOpacity: 0.5,
  baseOpacity: 0.32,
  accentOpacity: 0.18,
  shape: 1.2,
  accentShape: 2.5,
  centerFloor: 0,
  colorR: 255,
  colorG: 244,
  colorB: 232,
};

@Injectable({
  providedIn: 'root',
})
export class WakeOverlayService {
  private animationToken = 0;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private activeMode: WakeOverlayMode | null = null;
  private active = false;
  private currentOpacity = 0;
  private animationStartedAt = 0;
  private animationDurationMs = 0;
  private fadeOutStartOpacity = 0;
  private currentConfig: WakeOverlayDebugConfig = structuredClone(DEFAULT_WAKE_OVERLAY_CONFIG);
  private readonly _debugConfig = new BehaviorSubject<WakeOverlayDebugConfig>(
    structuredClone(DEFAULT_WAKE_OVERLAY_CONFIG)
  );
  private readonly _debugPreviewVisible = new BehaviorSubject<boolean>(false);

  public readonly debugConfig = this._debugConfig.asObservable();
  public readonly debugPreviewVisible = this._debugPreviewVisible.asObservable();

  constructor(private openvr: OpenVRService) {}

  async init() {
    this.openvr.status.subscribe((status) => {
      if (status !== 'INITIALIZED') {
        this.clearAnimation(true);
      }
    });
    await this.applyConfig(this.currentConfig);
    await this.setOpacity(0);
  }

  get defaultDebugConfig() {
    return structuredClone(DEFAULT_WAKE_OVERLAY_CONFIG);
  }

  get debugConfigSync() {
    return this._debugConfig.value;
  }

  get debugPreviewVisibleSync() {
    return this._debugPreviewVisible.value;
  }

  async updateDebugConfig(patch: Partial<WakeOverlayDebugConfig>) {
    const nextConfig = this.sanitizeConfig({
      ...this.currentConfig,
      ...patch,
    });
    this.currentConfig = nextConfig;
    this._debugConfig.next(structuredClone(nextConfig));
    await this.applyConfig(nextConfig);
    if (this.activeMode === 'debug_preview') {
      await this.setOpacity(nextConfig.maxOpacity);
    }
  }

  async resetDebugConfig() {
    await this.updateDebugConfig(this.defaultDebugConfig);
  }

  async showDebugPreview() {
    this.clearAnimation(false);
    await this.applyConfig(this.currentConfig);
    this.active = true;
    this.activeMode = 'debug_preview';
    this._debugPreviewVisible.next(true);
    await this.setOpacity(this.currentConfig.maxOpacity);
  }

  async hideDebugPreview() {
    if (this.activeMode !== 'debug_preview') return;
    await this.stopImmediate();
  }

  async startScheduledWake(totalDurationMs: number) {
    const durationMs = Math.max(0, Math.round(totalDurationMs));
    if (!durationMs) {
      await this.stopImmediate();
      return;
    }
    this.clearAnimation(false);
    await this.applyConfig(this.currentConfig);
    await this.setOpacity(0);
    this.active = true;
    this.activeMode = 'scheduled';
    this.animationStartedAt = Date.now();
    this.animationDurationMs = durationMs;
    this.scheduleNextTick(++this.animationToken);
  }

  async fadeOutGracefully(durationMs = WAKE_OVERLAY_INTERRUPT_FADE_OUT_MS) {
    if (!this.active && this.currentOpacity <= 0) return;
    this.clearTimer();
    this.active = true;
    this.activeMode = 'fade_out';
    this._debugPreviewVisible.next(false);
    this.animationStartedAt = Date.now();
    this.animationDurationMs = Math.max(0, Math.round(durationMs));
    this.fadeOutStartOpacity = this.currentOpacity;
    const token = ++this.animationToken;
    if (!this.animationDurationMs || this.fadeOutStartOpacity <= 0) {
      await this.stopImmediate();
      return;
    }
    this.scheduleNextTick(token);
  }

  async stopImmediate() {
    this.clearAnimation(false);
    await this.setOpacity(0);
  }

  private async applyConfig(config: WakeOverlayDebugConfig) {
    await invoke('openvr_set_wake_overlay_config', {
      config,
    });
  }

  private scheduleNextTick(token: number) {
    this.clearTimer();
    this.tickTimer = setTimeout(() => {
      void this.runTick(token);
    }, WAKE_OVERLAY_FRAME_INTERVAL_MS);
  }

  private async runTick(token: number) {
    if (token !== this.animationToken || !this.activeMode) return;
    const elapsedMs = Date.now() - this.animationStartedAt;
    switch (this.activeMode) {
      case 'scheduled':
        await this.runScheduledTick(token, elapsedMs);
        break;
      case 'fade_out':
        await this.runFadeOutTick(token, elapsedMs);
        break;
      case 'debug_preview':
        break;
    }
  }

  private async runScheduledTick(token: number, elapsedMs: number) {
    const totalDurationMs = this.animationDurationMs;
    const t1 = totalDurationMs * WAKE_OVERLAY_ON_RATIO;
    const t2 = totalDurationMs * (WAKE_OVERLAY_ON_RATIO + WAKE_OVERLAY_HOLD_RATIO);
    const t3 =
      totalDurationMs * (WAKE_OVERLAY_ON_RATIO + WAKE_OVERLAY_HOLD_RATIO + WAKE_OVERLAY_OFF_RATIO);
    if (elapsedMs >= t3) {
      await this.stopImmediate();
      return;
    }
    let nextOpacity = 0;
    if (elapsedMs <= t1) {
      nextOpacity = smoothLerp(0, this.currentConfig.maxOpacity, clamp(elapsedMs / t1, 0, 1));
    } else if (elapsedMs <= t2) {
      nextOpacity = this.currentConfig.maxOpacity;
    } else {
      const fadeOutProgress = clamp((elapsedMs - t2) / (t3 - t2), 0, 1);
      nextOpacity = smoothLerp(this.currentConfig.maxOpacity, 0, fadeOutProgress);
    }
    await this.setOpacity(nextOpacity);
    if (token === this.animationToken) this.scheduleNextTick(token);
  }

  private async runFadeOutTick(token: number, elapsedMs: number) {
    if (elapsedMs >= this.animationDurationMs) {
      await this.stopImmediate();
      return;
    }
    const nextOpacity = smoothLerp(
      this.fadeOutStartOpacity,
      0,
      clamp(elapsedMs / this.animationDurationMs, 0, 1)
    );
    await this.setOpacity(nextOpacity);
    if (token === this.animationToken) this.scheduleNextTick(token);
  }

  private async setOpacity(opacity: number) {
    const clampedOpacity = clamp(opacity, 0, this.currentConfig.maxOpacity);
    if (Math.abs(clampedOpacity - this.currentOpacity) < 0.001) return;
    this.currentOpacity = clampedOpacity;
    await invoke('openvr_set_wake_overlay_opacity', {
      opacity: clampedOpacity,
    });
  }

  private sanitizeConfig(config: WakeOverlayDebugConfig): WakeOverlayDebugConfig {
    const maxOpacity = clamp(config.maxOpacity, 0.01, 1);
    const innerRadius = clamp(config.innerRadius, 0, 0.999);
    const outerRadius = clamp(config.outerRadius, innerRadius + 0.001, 2);
    return {
      hmdProfile: config.hmdProfile || DEFAULT_WAKE_OVERLAY_CONFIG.hmdProfile,
      axisScaleX: clamp(config.axisScaleX, 0.1, 4),
      axisScaleY: clamp(config.axisScaleY, 0.1, 4),
      innerRadius,
      outerRadius,
      maxOpacity,
      baseOpacity: clamp(config.baseOpacity, 0, 1),
      accentOpacity: clamp(config.accentOpacity, 0, 1),
      shape: clamp(config.shape, 0.1, 8),
      accentShape: clamp(config.accentShape, 0.1, 8),
      centerFloor: clamp(config.centerFloor, 0, maxOpacity),
      colorR: Math.round(clamp(config.colorR, 0, 255)),
      colorG: Math.round(clamp(config.colorG, 0, 255)),
      colorB: Math.round(clamp(config.colorB, 0, 255)),
    };
  }

  private clearAnimation(resetOpacityState: boolean) {
    this.animationToken++;
    this.active = false;
    this.activeMode = null;
    this.animationStartedAt = 0;
    this.animationDurationMs = 0;
    this.fadeOutStartOpacity = 0;
    this.clearTimer();
    this._debugPreviewVisible.next(false);
    if (resetOpacityState) this.currentOpacity = 0;
  }

  private clearTimer() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
