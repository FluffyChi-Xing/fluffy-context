export interface ProgressUpdate {
  phase: string;
  completed: number;
  total: number | null;
  unit?: string;
}

export type ProgressReporter = (update: ProgressUpdate) => void;
