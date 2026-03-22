import { Component, Input } from '@angular/core';
import { BaseModalComponent } from '../../base-modal/base-modal.component';
import { SteamService } from 'src-ui/app/services/steam.service';
import {
  WakeOverlayDebugConfig,
  WakeOverlayService,
} from 'src-ui/app/services/overlay/wake-overlay.service';
import { SleepInductionOverlayAdaptationService } from 'src-ui/app/services/overlay-adaptation/sleep-induction-overlay-adaptation.service';

@Component({
  selector: 'app-misc-testing',
  templateUrl: './misc-testing.component.html',
  styleUrls: ['./misc-testing.component.scss'],
  standalone: false,
})
export class MiscTestingComponent {
  @Input() modal?: BaseModalComponent<any, any>;
  protected readonly wakeOverlayConfig;
  protected readonly wakeOverlayPreviewVisible;
  protected readonly sleepInductionAdaptationState;

  constructor(
    private steamService: SteamService,
    private wakeOverlay: WakeOverlayService,
    private sleepInductionOverlayAdaptation: SleepInductionOverlayAdaptationService
  ) {
    this.wakeOverlayConfig = this.wakeOverlay.debugConfig;
    this.wakeOverlayPreviewVisible = this.wakeOverlay.debugPreviewVisible;
    this.sleepInductionAdaptationState = this.sleepInductionOverlayAdaptation.debugState;
  }

  test() {
    this.steamService.setAchievement('NON_EXISTING_ACHIEVEMENT', true);
  }

  async toggleWakeOverlayPreview() {
    if (this.wakeOverlay.debugPreviewVisibleSync) {
      await this.wakeOverlay.hideDebugPreview();
      return;
    }
    await this.wakeOverlay.showDebugPreview();
  }

  async resetWakeOverlayConfig() {
    await this.wakeOverlay.resetDebugConfig();
  }

  async setNumberField(
    field: keyof WakeOverlayDebugConfig,
    value: string,
    fallback?: number
  ) {
    const parsed = Number(value);
    await this.wakeOverlay.updateDebugConfig({
      [field]: Number.isFinite(parsed) ? parsed : (fallback ?? 0),
    } as Partial<WakeOverlayDebugConfig>);
  }

  async setAdaptationLuminance(value: string, fallback = 0.18) {
    const parsed = Number(value);
    await this.sleepInductionOverlayAdaptation.setDebugEnvironmentLuminance(
      Number.isFinite(parsed) ? parsed : fallback
    );
  }

  async setAdaptationReliable(reliable: boolean) {
    await this.sleepInductionOverlayAdaptation.setDebugObservationReliable(reliable);
  }
}
