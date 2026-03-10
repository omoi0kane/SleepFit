export type ResearchEventType =
  | 'app_started'
  | 'app_stopped'
  | 'session_started'
  | 'session_stopped'
  | 'setting_changed'
  | 'sleep_mode_enabled'
  | 'sleep_mode_disabled'
  | 'sleep_preparation_started'
  | 'sleep_preparation_timed_out'
  | 'brightness_changed'
  | 'color_temperature_changed'
  | 'volume_changed'
  | 'overlay_opened'
  | 'automation_fired'
  | 'automation_cancelled'
  | 'manual_intervention'
  | 'error';

export type ResearchEventSource =
  | 'system'
  | 'user_desktop_ui'
  | 'user_overlay'
  | 'user_hotkey'
  | 'user_tray'
  | 'automation'
  | 'service'
  | 'unknown';

export type ResearchDomain =
  | 'sleep_mode'
  | 'sleep_preparation'
  | 'brightness'
  | 'color_temperature'
  | 'volume'
  | 'settings'
  | 'overlay'
  | 'automation'
  | 'app'
  | 'other';

export interface ResearchSettingChange {
  key: string;
  old_value: unknown;
  new_value: unknown;
  redacted?: boolean;
}

export interface ResearchLogEvent {
  event_id: string;
  timestamp: string;
  session_id: string;
  event_type: ResearchEventType;
  source: ResearchEventSource;
  app_version: string;
  payload: Record<string, unknown>;
}

export interface ResearchSessionFile {
  schema_version: 1;
  session_id: string;
  app_version: string;
  started_at: string;
  stopped_at: string | null;
  platform: 'windows';
  events: ResearchLogEvent[];
}
