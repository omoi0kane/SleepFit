import { Component } from '@angular/core';
import { filter } from 'rxjs';
import {
  AUTOMATION_CONFIGS_DEFAULT,
  SleepWakeTransitionProfileType,
  SleepWakeTransitionStep,
  SleepWakeTransitionTarget,
  SleepWakeTransitionsConfig,
} from '../../../../../../models/automations';
import { SleepDetectionTabComponent } from '../sleep-detection-tab.component';
import {
  AudioDevicePickerComponent,
  AudioDevicePickerInput,
  AudioDevicePickerOutput,
} from '../../../audio-volume-automations-view/audio-device-picker/audio-device-picker.component';
import { AudioDeviceService } from '../../../../../../services/audio-device.service';
import { SleepWakeTransitionService } from '../../../../../../services/sleep-wake-transition.service';

@Component({
  selector: 'app-sleep-wake-transition-tab',
  templateUrl: './sleep-wake-transition-tab.component.html',
  styleUrls: ['./sleep-wake-transition-tab.component.scss'],
  standalone: false,
})
export class SleepWakeTransitionTabComponent extends SleepDetectionTabComponent {
  protected readonly defaults = AUTOMATION_CONFIGS_DEFAULT.SLEEP_WAKE_TRANSITIONS;
  protected readonly profiles: SleepWakeTransitionProfileType[] = ['sleep', 'wake'];
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
    if (!this.config.audioDevicePersistentId) return 'Default playback device';
    return (
      this.audioDeviceService.getAudioDeviceNameForPersistentId(this.config.audioDevicePersistentId)
        ?.display ?? 'Default playback device'
    );
  }

  updateConfig(patch: Partial<SleepWakeTransitionsConfig>) {
    void this.automationConfigService.updateAutomationConfig<SleepWakeTransitionsConfig>(
      'SLEEP_WAKE_TRANSITIONS',
      patch
    );
  }

  updateSchedules(field: keyof SleepWakeTransitionsConfig['schedules'], value: boolean | string | null) {
    void this.updateConfig({
      schedules: {
        ...this.config.schedules,
        [field]: value,
      },
    });
  }

  updateProfile(profile: SleepWakeTransitionProfileType, patch: Partial<SleepWakeTransitionsConfig['profiles'][SleepWakeTransitionProfileType]>) {
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

  updateStep(
    profile: SleepWakeTransitionProfileType,
    stepId: string,
    field: keyof SleepWakeTransitionStep,
    value: string | number | boolean | null
  ) {
    this.updateProfile(profile, {
      steps: this.config.profiles[profile].steps.map((step) =>
        step.id === stepId ? ({ ...step, [field]: value } as SleepWakeTransitionStep) : step
      ),
    });
  }

  updateStepTransitionSeconds(
    profile: SleepWakeTransitionProfileType,
    stepId: string,
    value: number | null
  ) {
    this.updateStep(profile, stepId, 'transitionTimeMs', this.secondsToMs(value));
  }

  addStep(profile: SleepWakeTransitionProfileType) {
    const steps = [...this.config.profiles[profile].steps];
    const lastOffset = steps.length ? steps[steps.length - 1].offsetMinutes : 0;
    steps.push({
      id: `${profile}-${Date.now()}`,
      offsetMinutes: lastOffset + 15,
      transitionTimeMs: 600000,
      changeBrightness: true,
      brightness: profile === 'sleep' ? 40 : 85,
      softwareBrightness: profile === 'sleep' ? 40 : 85,
      hardwareBrightness: profile === 'sleep' ? 40 : 85,
      changeColorTemperature: true,
      colorTemperature: profile === 'sleep' ? 2800 : 5000,
      changeVolume: false,
      volume: profile === 'sleep' ? 25 : 60,
    });
    this.updateProfile(profile, { steps });
  }

  removeStep(profile: SleepWakeTransitionProfileType, stepId: string) {
    this.updateProfile(profile, {
      steps: this.config.profiles[profile].steps.filter((step) => step.id !== stepId),
    });
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
