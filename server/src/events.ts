import { EventEmitter } from 'node:events';
import type { Level, Signal } from './scoring/rules.js';

export interface IncidentEvent {
  incidentId: number;
  userId: number;
  username: string;
  level: Level;
  prevLevel: Level;
  score: number;
  signals: Signal[];
  activeIps: number;
}

export interface CycleEvent {
  at: number;
  durationMs: number;
  nodesOk: number;
  nodesTotal: number;
  usersSeen: number;
  ipsSeen: number;
}

interface Events {
  incident: [IncidentEvent];
  cycle: [CycleEvent];
}

export const bus = new EventEmitter<Events>();
