export type ChannelStatus =
  | 'initial'
  | 'opening'
  | 'active'
  | 'reconnecting'
  | 'reconnected'
  | 'errored';

export interface StatusUpdateEvent {
  status: ChannelStatus;
}

export interface FactEvent {
  id: number;
  time: number;
  data: any;
}

export interface ErrorEvent {
  time: number;
  msg: string;
}

export type IdUpdateEvent = Partial<{
  current: number;
  lastHeard: number;
  lastAcknowledged: number;
}>;

export interface ResetEvent {
  uid: string;
}

export type UrbitHttpApiEvent =
  | StatusUpdateEvent
  | IdUpdateEvent
  | FactEvent
  | ErrorEvent
  | ResetEvent;

export type UrbitHttpApiEventType =
  | 'status-update'
  | 'id-update'
  | 'fact'
  | 'error'
  | 'reset';
