export type FindingStatus = 'pass' | 'fail' | 'warn' | 'info';

export type RuleSource = 'KMBR' | 'CLIENT' | 'ASSUMPTION' | 'DATA' | 'PROGRAMME';

/**
 * One compliance line. `source` says whose rule it is and `reference` is the
 * clause, table or config key, so every number in the UI can be traced.
 */
export interface Finding {
  id: string;
  status: FindingStatus;
  source: RuleSource;
  /** Clause, table or config key: "KMBR Table 4", "client_rules.villa_plots.min_side_m". */
  reference: string;
  title: string;
  detail: string;
  /** Present when a client rule and KMBR disagree: both values are shown. */
  conflict?: {
    clientValue: string;
    kmbrValue: string;
    applied: string;
    appliedBy: 'KMBR' | 'CLIENT';
  };
  /** Where on the plan the finding applies, when it is local. */
  subjectId?: string;
}

export const pass = (f: Omit<Finding, 'status'>): Finding => ({ ...f, status: 'pass' });
export const fail = (f: Omit<Finding, 'status'>): Finding => ({ ...f, status: 'fail' });
export const warn = (f: Omit<Finding, 'status'>): Finding => ({ ...f, status: 'warn' });
export const info = (f: Omit<Finding, 'status'>): Finding => ({ ...f, status: 'info' });

export const worstStatus = (findings: readonly Finding[]): FindingStatus => {
  if (findings.some((f) => f.status === 'fail')) return 'fail';
  if (findings.some((f) => f.status === 'warn')) return 'warn';
  if (findings.some((f) => f.status === 'pass')) return 'pass';
  return 'info';
};

export const countByStatus = (findings: readonly Finding[]): Record<FindingStatus, number> => {
  const out: Record<FindingStatus, number> = { pass: 0, fail: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.status]++;
  return out;
};
