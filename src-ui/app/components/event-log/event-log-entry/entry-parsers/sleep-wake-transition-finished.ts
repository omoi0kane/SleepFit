import { EventLogEntryParser } from '../event-log-entry-parser';
import {
  EventLogSleepWakeTransitionFinished,
  EventLogType,
} from '../../../../models/event-log-entry';

export class EventLogSleepWakeTransitionFinishedEntryParser extends EventLogEntryParser<EventLogSleepWakeTransitionFinished> {
  entryType(): EventLogType {
    return 'sleepWakeTransitionFinished';
  }

  override headerInfoTitle(entry: EventLogSleepWakeTransitionFinished): string {
    return `${entry.profile === 'sleep' ? 'Sleep' : 'Wake'} transition finished`;
  }

  override headerInfoSubTitle(entry: EventLogSleepWakeTransitionFinished): string {
    return entry.reason === 'MANUAL' ? 'Finished manually' : 'Finished scheduled run';
  }
}
