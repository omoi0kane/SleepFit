import { EventLogEntryParser } from '../event-log-entry-parser';
import {
  EventLogSleepWakeTransitionCancelled,
  EventLogType,
} from '../../../../models/event-log-entry';

export class EventLogSleepWakeTransitionCancelledEntryParser extends EventLogEntryParser<EventLogSleepWakeTransitionCancelled> {
  entryType(): EventLogType {
    return 'sleepWakeTransitionCancelled';
  }

  override headerInfoTitle(entry: EventLogSleepWakeTransitionCancelled): string {
    return `${entry.profile === 'sleep' ? 'Sleep' : 'Wake'} transition cancelled`;
  }

  override headerInfoSubTitle(entry: EventLogSleepWakeTransitionCancelled): string {
    switch (entry.reason) {
      case 'MANUAL_OVERRIDE':
        return 'Cancelled by manual transition';
      case 'MANUAL_REVERT':
        return 'Cancelled by revert';
      case 'USER_INTERVENTION':
        return 'Cancelled by user intervention';
      default:
        return 'Cancelled by system';
    }
  }
}
