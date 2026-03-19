import { Component } from '@angular/core';
import { filter } from 'rxjs';
import {
  AUTOMATION_CONFIGS_DEFAULT,
  SleepWakeScheduledCurveMode,
  SleepWakeTransitionProfileType,
  SleepWakeTransitionTarget,
  SleepWakeTransitionsConfig,
} from '../../../../../../models/automations';
import { AudioDeviceService } from '../../../../../../services/audio-device.service';
import { SleepWakeTransitionService } from '../../../../../../services/sleep-wake-transition.service';
import { SleepDetectionTabComponent } from '../sleep-detection-tab.component';
import {
  AudioDevicePickerComponent,
  AudioDevicePickerInput,
  AudioDevicePickerOutput,
} from '../../../audio-volume-automations-view/audio-device-picker/audio-device-picker.component';

@Component({
  selector: 'app-sleep-wake-transition-tab',
  templateUrl: './sleep-wake-transition-tab.component.html',
  styleUrls: ['./sleep-wake-transition-tab.component.scss'],
  standalone: false,
})
export class SleepWakeTransitionTabComponent extends SleepDetectionTabComponent {
  protected readonly defaults = AUTOMATION_CONFIGS_DEFAULT.SLEEP_WAKE_TRANSITIONS;
  protected readonly profiles: SleepWakeTransitionProfileType[] = ['sleep', 'wake'];
  protected readonly wakeCurveModes: SleepWakeScheduledCurveMode[] = ['CLASSIC', 'EVIDENCE_BASED'];
  protected readonly skipNextSleepScheduleActive;

  constructor(
    private audioDeviceService: AudioDeviceService,
    private sleepWakeTransitionService: SleepWakeTransitionService
  ) {
    super();
    this.skipNextSleepScheduleActive = this.sleepWakeTransitionService.skipNextSleepScheduleActive;
  }

  get config(): SleepWakeTransitionsConfig {
    return this.automationConfigs.SLEEP_WAKE_TRANSITIONS;
  }

  getAudioDeviceLabel() {
    if (!this.config.audioDevicePersistentId) return '既定の再生デバイス';
    return (
      this.audioDeviceService.getAudioDeviceNameForPersistentId(this.config.audioDevicePersistentId)
        ?.display ?? '既定の再生デバイス'
    );
  }

  isSleepProfile(profile: SleepWakeTransitionProfileType) {
    return profile === 'sleep';
  }

  updateConfig(patch: Partial<SleepWakeTransitionsConfig>) {
    void this.automationConfigService.updateAutomationConfig<SleepWakeTransitionsConfig>(
      'SLEEP_WAKE_TRANSITIONS',
      patch
    );
  }

  updateSchedules(
    field: keyof SleepWakeTransitionsConfig['schedules'],
    value: boolean | string | null
  ) {
    void this.updateConfig({
      schedules: {
        ...this.config.schedules,
        [field]: value,
      },
    });
  }

  updateProfile(
    profile: SleepWakeTransitionProfileType,
    patch: Partial<SleepWakeTransitionsConfig['profiles'][SleepWakeTransitionProfileType]>
  ) {
    void this.updateConfig({
      profiles: {
        ...this.config.profiles,
        [profile]: {
          ...this.config.profiles[profile],
          ...patch,
        },
      },
    });
  }

  updateTarget(
    profile: SleepWakeTransitionProfileType,
    field: keyof SleepWakeTransitionTarget,
    value: number | boolean | null
  ) {
    this.updateProfile(profile, {
      manualTarget: {
        ...this.config.profiles[profile].manualTarget,
        [field]: value,
      },
    });
  }

  updateTargetTransitionSeconds(profile: SleepWakeTransitionProfileType, value: number | null) {
    this.updateTarget(profile, 'transitionTimeMs', this.secondsToMs(value));
  }

  updateManualTransitionSeconds(profile: SleepWakeTransitionProfileType, value: number | null) {
    this.updateProfile(profile, {
      manualTransitionTimeMs: this.secondsToMs(value),
    });
  }

  updateScheduledTransitionSeconds(profile: SleepWakeTransitionProfileType, value: number | null) {
    this.updateProfile(profile, {
      scheduledTransitionTimeMs: this.secondsToMs(value),
    });
  }

  getManualTransitionSeconds(profile: SleepWakeTransitionProfileType) {
    return this.msToSeconds(
      this.config.profiles[profile].manualTransitionTimeMs ??
        this.config.profiles[profile].manualTarget.transitionTimeMs
    );
  }

  getScheduledTransitionSeconds(profile: SleepWakeTransitionProfileType) {
    return this.msToSeconds(
      this.config.profiles[profile].scheduledTransitionTimeMs ??
        this.config.profiles[profile].manualTarget.transitionTimeMs
    );
  }

  updateScheduledCurveMode(mode: SleepWakeScheduledCurveMode) {
    this.updateProfile('wake', {
      scheduledCurveMode: mode,
    });
  }

  getScheduledCurveMode() {
    return this.config.profiles.wake.scheduledCurveMode ?? 'CLASSIC';
  }

  pickAudioDevice() {
    this.modalService
      .addModal<AudioDevicePickerInput, AudioDevicePickerOutput>(
        AudioDevicePickerComponent,
        {},
        {
          wrapperDefaultClass: 'modal-wrapper-audio-device-picker',
        }
      )
      .pipe(filter(Boolean))
      .subscribe((res) => {
        this.updateConfig({
          audioDevicePersistentId: res.device.persistentId!,
        });
      });
  }

  clearSkipNextSleepSchedule() {
    this.sleepWakeTransitionService.clearSkipNextSleepSchedule();
  }

  msToSeconds(value: number | null | undefined) {
    return Math.round((value ?? 0) / 1000);
  }

  private secondsToMs(value: number | null) {
    return Math.max(0, Math.round((value ?? 0) * 1000));
  }
}
