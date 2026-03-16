import { EventLogEntryParser } from '../event-log-entry-parser';
import {
  EventLogSleepWakeTransitionStarted,
  EventLogType,
} from '../../../../models/event-log-entry';

export class EventLogSleepWakeTransitionStartedEntryParser extends EventLogEntryParser<EventLogSleepWakeTransitionStarted> {
  entryType(): EventLogType {
    return 'sleepWakeTransitionStarted';
  }

  override headerInfoTitle(entry: EventLogSleepWakeTransitionStarted): string {
    return `${entry.profile === 'sleep' ? 'Sleep' : 'Wake'} transition started`;
  }

  override headerInfoSubTitle(entry: EventLogSleepWakeTransitionStarted): string {
    return entry.reason === 'MANUAL' ? 'Started manually' : 'Started by schedule';
  }
}
