/**
 * Plain-English claim summary.
 *
 * Takes labeled segments (the RAG output of src/rag.ts) and explains, in
 * human English, what the claim is charging: who submitted it to whom,
 * which patients, which services (CPT/HCPCS + plain-English names), and
 * the billed amounts.
 *
 * HIPAA notes:
 *  - Full mode applies *minimum necessary* (45 CFR 164.502(b)): only the
 *    elements needed to explain the billing are surfaced (see
 *    usedElements). Patient addresses (N3/N4) are never included.
 *  - De-identified mode applies Safe-Harbor-style redaction
 *    (164.514(b)(2)): names, party IDs, claim numbers, dates, age/sex
 *    detail and free-text remarks are removed, so the resulting text is
 *    no longer PHI and can be shared (e.g. in a ticket or email).
 *    Amounts and service codes are retained so the billing stays
 *    explainable.
 *  - Access control for the endpoint is enforced by the wrapping API
 *    (see README, "HIPAA considerations"); this module only shapes data.
 */

import { ParsedSegment } from './parse837';

export interface SummaryOptions {
  /** When true, apply Safe-Harbor-style de-identification. */
  deidentify?: boolean;
}

export interface SummaryLine {
  /** CPT/HCPCS code (SV102). */
  code: string;
  /** Plain-English name of the service, when known. */
  description: string;
  units: number;
  unitAmount: number | null;
}

export interface SummaryClaim {
  /** CLM01 claim number (redacted in de-identified mode). */
  claimNumber: string;
  /** CLM04 claim type code. */
  claimType: string;
  /** Patient name (N1*PI N102) or '[name redacted]'. */
  patient: string;
  /** e.g. "male, 56 years old" ('' in de-identified mode). */
  patientDetail: string;
  /** CLM05 total charge amount. */
  billed: number;
  lines: SummaryLine[];
}

export interface ClaimSummary {
  /** The plain-English explanation. */
  text: string;
  /** ST04 interchange standard (e.g. 005010X222). */
  standard: string | null;
  /** BHT02 claim type code. */
  claimType: string | null;
  claimTypeText: string;
  /** BHT04, YYYY-MM-DD (null in de-identified mode). */
  preparedDate: string | null;
  totalBilled: number;
  claimCount: number;
  claims: SummaryClaim[];
  /** Categories redacted in de-identified mode (empty otherwise). */
  redactions: string[];
  /** Claim elements the summary used (minimum-necessary audit trail). */
  usedElements: string[];
}

const CLAIM_TYPES: Record<string, string> = {
  '00': 'institutional (facility)',
  '1': 'individual or professional',
  '70': 'professional (office)',
  '71': 'inpatient',
  '72': 'outpatient',
  '77': 'institutional inpatient',
  '78': 'institutional outpatient',
  '80': 'institutional',
  '83': 'professional (office)',
};

const CPT: Record<string, string> = {
  '99211': 'office visit, established patient (lowest level)',
  '99212': 'office visit, established patient (low level)',
  '99213': 'office visit, established patient',
  '99214': 'office visit, established patient (higher complexity)',
  '99215': 'office visit, established patient (highest complexity)',
  '99203': 'new-patient office visit',
  '99204': 'new-patient office visit (higher complexity)',
  '99205': 'new-patient office visit (highest complexity)',
  '99396': 'preventive visit, established patient',
  '90832': 'psychotherapy, 30 minutes',
};

const SEX: Record<string, string> = { M: 'male', F: 'female' };

function el(seg: ParsedSegment, i: number): string {
  const e = seg.elements[i];
  return e ? e.display : '';
}

function money(n: number): string {
  return '$' + n.toFixed(2);
}

/** 20251119 -> 2025-11-19 (also accepts YYMMDD, assuming 20xx). */
function fmtDate(v: string): string | null {
  if (!/^\d{6,8}$/.test(v)) return null;
  const d = v.length === 6 ? '20' + v : v;
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
}

/** 'DOE, JOHN' -> 'JOHN DOE' (display normalization; suffixed names like
 * 'SMITH, JANE MD' are left untouched). */
function prettyName(v: string): string {
  const m = v.match(/^(\w+),\s*(\w+)$/);
  return m ? m[2] + ' ' + m[1] : v;
}

export function buildClaimSummary(
  segments: ParsedSegment[],
  opts: SummaryOptions = {}
): ClaimSummary {
  const deid = !!opts.deidentify;
  const used = new Set<string>();
  const redactions: string[] = [];

  // Group segments per claim loop: each CLM starts a new claim group.
  const clmPositions: number[] = [];
  segments.forEach((s, i) => {
    if (s.id === 'CLM') clmPositions.push(i);
  });
  const batch = clmPositions.length ? segments.slice(0, clmPositions[0]) : segments;
  const groups = clmPositions.map((start, k) =>
    segments.slice(start, clmPositions[k + 1] ?? segments.length)
  );

  // Batch-level facts.
  const st = batch.find((s) => s.id === 'ST');
  const bht = batch.find((s) => s.id === 'BHT');
  const provider = batch.find((s) => s.id === 'N1' && el(s, 0).toUpperCase() === '41');
  const payer = batch.find((s) => s.id === 'N1' && el(s, 0).toUpperCase() === '40');
  const remarks = segments.filter((s) => s.id === 'NT').map((s) => el(s, 2)).filter(Boolean);

  const standard = st ? el(st, 3) : null;
  if (standard) used.add('ST04');
  const claimType = bht ? el(bht, 1) : null;
  if (claimType) used.add('BHT02');
  const preparedDate = bht ? fmtDate(el(bht, 3)) : null;
  if (bht && el(bht, 3)) used.add('BHT04');

  const providerName = provider ? prettyName(el(provider, 1)) : '';
  const providerId = provider ? (el(provider, 3) + ' ' + el(provider, 4)).trim() : '';
  if (providerName) {
    used.add('N101');
    used.add('N102');
  }
  if (providerId) {
    used.add('N104');
    used.add('N105');
  }
  const payerName = payer ? prettyName(el(payer, 1)) : '';

  // Per-claim facts.
  const claims: SummaryClaim[] = groups.map((group) => {
    const clm = group.find((s) => s.id === 'CLM')!;
    const patientN1 = group.find((s) => s.id === 'N1' && el(s, 0).toUpperCase() === 'PI');
    const sbr = group.find((s) => s.id === 'SBR');
    const sv1 = group.find((s) => s.id === 'SV1');
    const alx = group.find((s) => s.id === 'ALX');
    const lseg = group.find((s) => s.id === 'L');

    const claimNumber = el(clm, 0);
    const type = el(clm, 3);
    const billed = parseFloat(el(clm, 4)) || 0;
    if (claimNumber) used.add('CLM01');
    if (type) used.add('CLM04');
    if (el(clm, 4)) used.add('CLM05');

    let patient = patientN1 ? prettyName(el(patientN1, 1)) : '';
    if (patient) used.add('N102');

    let detail = '';
    const sex = sbr ? SEX[el(sbr, 2).toUpperCase()] ?? '' : '';
    const age = (sbr && el(sbr, 5)) || el(clm, 6) || '';
    if (sex) used.add('SBR03');
    if (sbr && el(sbr, 5)) used.add('SBR06');
    if (el(clm, 6)) used.add('CLM07');
    detail = [sex, age ? age + ' years old' : ''].filter(Boolean).join(', ');

    const lines: SummaryLine[] = [];
    if (sv1) {
      const code = el(sv1, 1);
      if (code) {
        used.add('SV102');
        let units = 1;
        let unitAmount: number | null = null;
        if (alx) {
          units = parseInt(el(alx, 1), 10) || 1;
          unitAmount = parseFloat(el(alx, 3)) || null;
          if (el(alx, 1)) used.add('ALX02');
          if (el(alx, 3)) used.add('ALX04');
        } else if (lseg) {
          unitAmount = parseFloat(el(lseg, 1)) || null;
        }
        lines.push({ code, description: CPT[code] ?? '', units, unitAmount });
      }
    }

    return { claimNumber, claimType: type, patient, patientDetail: detail, billed, lines };
  });

  const totalBilled = claims.reduce((n, c) => n + c.billed, 0);

  // What de-identification will cover (only categories actually present).
  if (deid) {
    if (claims.some((c) => c.claimNumber)) redactions.push('claim numbers');
    if (preparedDate) redactions.push('dates');
    if (claims.some((c) => c.patient) || providerName || payerName) redactions.push('names');
    if (providerId) redactions.push('party IDs');
    if (claims.some((c) => c.patientDetail)) redactions.push('age/sex detail');
    if (remarks.length) redactions.push('remarks');
  }
  if (!deid && remarks.length) used.add('NT03');

  // Plain English.
  const claimTypeText = claimType ? CLAIM_TYPES[claimType] ?? 'health care' : 'health care';
  const article = /^[aeiou]/i.test(claimTypeText) ? 'an' : 'a';
  const datePart = deid
    ? preparedDate
      ? ', with the preparation date redacted'
      : ''
    : preparedDate
      ? ', prepared ' + preparedDate
      : '';
  const providerText = providerName
    ? deid
      ? 'a provider'
      : providerName + (providerId ? ' (' + (deid ? 'ID redacted' : providerId) + ')' : '')
    : 'a provider';
  const payerText = payerName && !deid ? payerName : payerName ? 'a payer' : 'a payer';

  const sentences: string[] = [];
  sentences.push(
    'This is ' + article + ' ' + claimTypeText + ' EDI 837 claim' +
      (standard ? ' (standard ' + standard + ')' : '') +
      datePart +
      ', submitted by ' + providerText + ' to ' + (payerText === 'a payer' ? 'a payer' : payerText) + '.'
  );
  sentences.push(
    'It contains ' + claims.length + ' claim' + (claims.length === 1 ? '' : 's') +
      ' covering ' + claims.length + ' patient' + (claims.length === 1 ? '' : 's') +
      ', with a total billed amount of ' + money(totalBilled) + '.'
  );
  for (const c of claims) {
    const num = deid ? '[claim number redacted]' : c.claimNumber;
    const who = deid ? 'a patient' : c.patient || 'a patient';
    const detailText = deid ? '' : c.patientDetail ? ' (' + c.patientDetail + ')' : '';
    const lineText = c.lines
      .map((l) => {
        const desc = l.description ? ' (' + l.description + ')' : '';
        const amt = l.unitAmount != null ? ' at ' + money(l.unitAmount) + ' per unit' : '';
        return l.units + ' unit' + (l.units === 1 ? '' : 's') + ' of CPT ' + l.code + desc + amt;
      })
      .join('; ');
    sentences.push(
      'Claim ' + num + ': ' + who + detailText + ' was billed ' + money(c.billed) +
        (lineText ? ' for ' + lineText + '.' : '.')
    );
  }
  if (!deid && remarks.length) sentences.push('Remarks: ' + remarks.join(' ') + '.');

  return {
    text: sentences.join(' '),
    standard,
    claimType,
    claimTypeText,
    preparedDate: deid ? null : preparedDate,
    totalBilled,
    claimCount: claims.length,
    claims: claims.map((c) => ({
      claimNumber: deid ? '[claim number redacted]' : c.claimNumber,
      claimType: c.claimType,
      patient: deid ? '[name redacted]' : c.patient,
      patientDetail: deid ? '' : c.patientDetail,
      billed: c.billed,
      lines: c.lines,
    })),
    redactions,
    usedElements: [...used].sort(),
  };
}
