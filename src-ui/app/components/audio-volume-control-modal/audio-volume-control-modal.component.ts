import { Component, DestroyRef, OnInit } from '@angular/core';
import { BaseModalComponent } from '../base-modal/base-modal.component';
import { ModalOptions } from '../../services/modal.service';
import { fadeUp, hshrink, vshrink } from '../../utils/animations';
import { asyncScheduler, Subject, switchMap, throttleTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SleepWakeTransitionService } from '../../services/sleep-wake-transition.service';

@Component({
  selector: 'app-audio-volume-control-modal',
  templateUrl: './audio-volume-control-modal.component.html',
  styleUrls: ['./audio-volume-control-modal.component.scss'],
  animations: [fadeUp(), vshrink(), hshrink()],
  standalone: false,
})
export class AudioVolumeControlModalComponent
  extends BaseModalComponent<void, void>
  implements OnInit
{
  protected readonly relativeVolumeState = this.sleepWakeTransition.relativeVolumeState;
  protected readonly setRelativeVolume = new Subject<number>();

  constructor(
    private sleepWakeTransition: SleepWakeTransitionService,
    private destroyRef: DestroyRef
  ) {
    super();
    this.setRelativeVolume
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        throttleTime(1000 / 30, asyncScheduler, { leading: true, trailing: true }),
        switchMap((percentage) =>
          this.sleepWakeTransition.setRelativeVolumePercent(percentage, 'user_desktop_ui')
        )
      )
      .subscribe();
  }

  ngOnInit(): void {}

  override getOptionsOverride(): Partial<ModalOptions> {
    return {
      wrapperDefaultClass: 'modal-wrapper-brightness-control',
    };
  }
}
