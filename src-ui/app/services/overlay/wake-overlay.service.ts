import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { OpenVRService } from '../openvr.service';
import { clamp, smoothLerp } from '../../utils/number-utils';

const WAKE_OVERLAY_ON_RATIO = 0.4;
const WAKE_OVERLAY_HOLD_RATIO = 0.4;
const WAKE_OVERLAY_OFF_RATIO = 1 - WAKE_OVERLAY_ON_RATIO - WAKE_OVERLAY_HOLD_RATIO;
const WAKE_OVERLAY_MAX_OPACITY = 0.5;
const WAKE_OVERLAY_INTERRUPT_FADE_OUT_MS = 10_000;
const WAKE_OVERLAY_FRAME_INTERVAL_MS = 1000 / 30;

type WakeOverlayMode = 'scheduled' | 'fade_out';

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

  constructor(private openvr: OpenVRService) {}

  async init() {
    this.openvr.status.subscribe((status) => {
      if (status !== 'INITIALIZED' && this.active) {
        this.clearAnimation(false);
      }
    });
    await this.setOpacity(0);
  }

  async startScheduledWake(totalDurationMs: number) {
    const durationMs = Math.max(0, Math.round(totalDurationMs));
    if (!durationMs) {
      await this.stopImmediate();
      return;
    }
    this.clearAnimation(false);
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
    }
  }

  private async runScheduledTick(token: number, elapsedMs: number) {
    const totalDurationMs = this.animationDurationMs;
    const t1 = totalDurationMs * WAKE_OVERLAY_ON_RATIO;
    const t2 = totalDurationMs * (WAKE_OVERLAY_ON_RATIO + WAKE_OVERLAY_HOLD_RATIO);
    const t3 = totalDurationMs * (WAKE_OVERLAY_ON_RATIO + WAKE_OVERLAY_HOLD_RATIO + WAKE_OVERLAY_OFF_RATIO);
    if (elapsedMs >= t3) {
      await this.stopImmediate();
      return;
    }
    let nextOpacity = 0;
    if (elapsedMs <= t1) {
      nextOpacity = smoothLerp(0, WAKE_OVERLAY_MAX_OPACITY, clamp(elapsedMs / t1, 0, 1));
    } else if (elapsedMs <= t2) {
      nextOpacity = WAKE_OVERLAY_MAX_OPACITY;
    } else {
      const fadeOutProgress = clamp((elapsedMs - t2) / (t3 - t2), 0, 1);
      nextOpacity = smoothLerp(WAKE_OVERLAY_MAX_OPACITY, 0, fadeOutProgress);
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
    const clampedOpacity = clamp(opacity, 0, WAKE_OVERLAY_MAX_OPACITY);
    if (Math.abs(clampedOpacity - this.currentOpacity) < 0.001) return;
    this.currentOpacity = clampedOpacity;
    await invoke('openvr_set_wake_overlay_opacity', {
      opacity: clampedOpacity,
    });
  }

  private clearAnimation(resetOpacityState: boolean) {
    this.animationToken++;
    this.active = false;
    this.activeMode = null;
    this.animationStartedAt = 0;
    this.animationDurationMs = 0;
    this.fadeOutStartOpacity = 0;
    this.clearTimer();
    if (resetOpacityState) this.currentOpacity = 0;
  }

  private clearTimer() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
