/**
 * Built-in EDI 837 (005010 X222, professional) knowledge base.
 *
 * At server startup every segment spec below is embedded and stored in
 * the vector database as a `kb` record. At export time the RAG pipeline
 * retrieves the spec for each segment ID seen in the claim via a
 * similarity search, so field labels come from the vector store rather
 * than being hard-coded into the renderer.
 *
 * Chunk text format (machine-parseable, human-readable):
 *   SEG BHT Claim Batch Header
 *   EL 01 BHT01 Standard Loop Code :: The loop this segment belongs to.
 */

export type KbElementDef = [code: string, name: string, desc: string];

export interface SegmentSpec {
  name: string;
  elements: ReadonlyArray<KbElementDef>;
}

export interface ParsedSpecElement {
  code: string;
  name: string;
  desc: string;
}

export interface ParsedSpec {
  segId: string;
  name: string;
  elements: { [index: number]: ParsedSpecElement };
}

export interface KbChunk {
  segId: string;
  name: string;
  text: string;
}

const SEGMENTS: Record<string, SegmentSpec> = {
  ISA: {
    name: 'Interchange Header',
    elements: [
      ['ISA01', 'Functional Identifier Code', 'EDI version of the interchange (00 = X12).'],
      ['ISA02', 'Implementation Qualifier', 'Implementation-specific qualifier; blank in most files.'],
      ['ISA03', 'Implementation Code', 'Implementation-specific code (often 00).'],
      ['ISA04', 'Implementation Qualifier 2', 'Implementation-specific; blank in most files.'],
      ['ISA05', 'Sender ID Qualifier', 'Qualifier for the sender ID (00 = unspecified, ZZ = private).'],
      ['ISA06', 'Sender ID', 'Identifier of the interchange sender (provider).'],
      ['ISA07', 'Receiver ID Qualifier', 'Qualifier for the receiver ID.'],
      ['ISA08', 'Receiver ID', 'Identifier of the interchange receiver (payer).'],
      ['ISA09', 'Interchange Date', 'Date the interchange was created (YYMMDD).'],
      ['ISA10', 'Interchange Time', 'Time the interchange was created (HHMM, 24-hour).'],
      ['ISA11', 'Control Standards Identifier', 'X12 uses U.'],
      ['ISA12', 'Interchange Version Number', 'Interchange version (00501 = X12 5010).'],
      ['ISA13', 'Interchange Control Number', 'Sequential control number for the interchange.'],
      ['ISA14', 'Reserved', 'Reserved character (0).'],
      ['ISA15', 'Repeating Element Separator', 'P = production, T = test/sandbox.'],
    ],
  },
  GS: {
    name: 'Functional Group Header',
    elements: [
      ['GS01', 'Functional Group Qualifier Code', 'Function group (HS = healthcare).'],
      ['GS02', 'Functional Group Sender ID', 'ID of the functional group sender.'],
      ['GS03', 'Functional Group Receiver ID', 'ID of the functional group receiver.'],
      ['GS04', 'Date', 'Date of the functional group (YYYYMMDD).'],
      ['GS05', 'Time', 'Time of the functional group.'],
      ['GS06', 'Version Information', 'Version/release/industry (^ = standard).'],
      ['GS07', 'Functional Group Control Number', 'Sequential control number for the group.'],
    ],
  },
  ST: {
    name: 'Transaction Set Header',
    elements: [
      ['ST01', 'Transaction Set Code', '837 = healthcare claim/encounter.'],
      ['ST02', 'Transaction Set Control Number', 'Sequential control number for the transaction set.'],
      ['ST03', 'Version / Release / Industry', 'Version release industry (005010X222 = 5010, X222).'],
    ],
  },
  SE: {
    name: 'Transaction Set Trailer',
    elements: [
      ['SE01', 'Number of Segments in Transaction Set', 'Count of segments between ST and SE, inclusive.'],
      ['SE02', 'Transaction Set Control Number', 'Echo of ST02.'],
    ],
  },
  GE: {
    name: 'Functional Group Trailer',
    elements: [
      ['GE01', 'Number of Transactions in Functional Group', 'Count of ST transaction sets in the group.'],
      ['GE02', 'Functional Group Control Number', 'Echo of GS07.'],
    ],
  },
  IEA: {
    name: 'Interchange Trailer',
    elements: [
      ['IEA01', 'Number of Transaction Sets in Interchange', 'Count of functional groups in the interchange.'],
      ['IEA02', 'Interchange Control Number', 'Echo of ISA10.'],
    ],
  },
  BHT: {
    name: 'Claim Batch Header',
    elements: [
      ['BHT01', 'Standard Loop Code', 'Loop this segment belongs to (0010 = claim batch header).'],
      ['BHT02', 'Claim Type Code', '1 = individual or professional claim.'],
      ['BHT03', 'Claim Frequency Code', '2 = original claim, 3 = re-bill, 4 = corrected claim.'],
      ['BHT04', 'Date', 'Date the claim was prepared (YYYYMMDD).'],
      ['BHT05', 'Time', 'Time the claim was prepared.'],
    ],
  },
  DTM: {
    name: 'Date / Time / Period',
    elements: [
      ['DTM01', 'Date / Time Qualifier Code', 'Qualifier describing what the date refers to.'],
      ['DTM02', 'Date', 'The date itself (YYYYMMDD).'],
      ['DTM03', 'Time', 'Optional time of day.'],
    ],
  },
  HOID: {
    name: 'Health Care Payer Identifier',
    elements: [
      ['HOID01', 'Prior Payer Name', 'Name of a prior payer.'],
      ['HOID02', 'Prior Payer ID Qualifier', 'Qualifier for the prior payer ID.'],
      ['HOID03', 'Prior Payer ID', 'ID of the prior payer.'],
    ],
  },
  N1: {
    name: 'Party Identification',
    elements: [
      ['N101', 'Entity Code', 'Who this party is (40 = payer, 41 = claim receiver, 47 = payer plan, PI = patient).'],
      ['N102', 'Entity Name', 'Name of the party.'],
      ['N103', 'Identification Code Qualifier', 'Qualifier for the party ID (XX, NPI, ST, SS...).'],
      ['N104', 'Identification Code', 'The party ID value.'],
      ['N105', 'Entity Identifier Code', 'Additional entity identifier.'],
      ['N106', 'Code List Qualifier Code', 'Qualifier for the code list (XX = ANSI, BL = blue cross...).'],
      ['N107', 'Code', 'Code value (e.g. payer or plan code).'],
      ['N108', 'Code List Qualifier Code 2', 'Second code list qualifier.'],
      ['N109', 'Code 2', 'Second code value.'],
      ['N110', 'Code List Qualifier Code 3', 'Third code list qualifier.'],
      ['N111', 'Code 3', 'Third code value.'],
    ],
  },
  N3: {
    name: 'Party Location',
    elements: [
      ['N301', 'Address Line 1', 'First line of the postal address.'],
      ['N302', 'Address Line 2', 'Second line of the postal address.'],
      ['N303', 'City', 'City.'],
      ['N304', 'State Or Province', 'State or province code.'],
      ['N305', 'Postal Code', 'ZIP / postal code.'],
    ],
  },
  N4: {
    name: 'Party Geographic',
    elements: [
      ['N401', 'City', 'City.'],
      ['N402', 'State Or Province', 'State or province code.'],
      ['N403', 'Postal Code', 'ZIP / postal code.'],
      ['N404', 'Country Code', 'Country (ISO code, e.g. US).'],
    ],
  },
  HL: {
    name: 'Hierarchical Structure',
    elements: [
      ['HL01', 'Hierarchical ID Number', 'Unique ID of the current loop instance.'],
      ['HL02', 'Parent Hierarchical ID Number', 'ID of the parent loop (0 = top level).'],
    ],
  },
  CLM: {
    name: 'Claim',
    elements: [
      ['CLM01', 'Claim Number', 'Unique claim / transaction number (NDC).'],
      ['CLM02', 'Billing Provider Identifier', 'ID of the billing provider.'],
      ['CLM03', 'Billing Provider ID Qualifier', 'Qualifier for the billing provider ID (45 = NPI, 1 = PIC, 2 = FEIN).'],
      ['CLM04', 'Claim Type Code', '70 = professional, 71 = inpatient, 72 = outpatient.'],
      ['CLM05', 'Total Charge Amount', 'Total billed amount for the claim.'],
      ['CLM06', 'Revenue Code Qualifier Code', 'Qualifier for the following data (25 = patient age).'],
      ['CLM07', 'Patient Age', 'Patient age in years.'],
      ['CLM08', 'Discharge Disposition Code', 'How the patient was discharged.'],
      ['CLM09', 'Change Indicator Code', 'A = added, C = changed claim.'],
    ],
  },
  SV1: {
    name: 'Service',
    elements: [
      ['SV101', 'Service Type Code', '46 = evaluation and management.'],
      ['SV102', 'Health Care Provider Code', 'HCPCS / CPT procedure code.'],
    ],
  },
  L: {
    name: 'Line Priced Unit',
    elements: [
      ['L01', 'Line Status Code', 'BI = billed to this payer, PR = billed to another payer.'],
      ['L02', 'Line Amount', 'Total amount for this service line.'],
    ],
  },
  ALX: {
    name: 'Alternate Priced Unit',
    elements: [
      ['ALX01', 'Revenue Code', 'Revenue code for the priced unit.'],
      ['ALX02', 'Priced Unit', 'Quantity of the priced unit.'],
      ['ALX03', 'Priced Unit Qualifier Code', 'Qualifier for the priced unit.'],
      ['ALX04', 'Priced Unit Amount', 'Unit price amount.'],
      ['ALX05', 'Priced Unit Amount Modifier Code', 'Modifier for the unit amount.'],
      ['ALX06', 'Priced Unit Quantity', 'Quantity.'],
      ['ALX07', 'Priced Unit Unit of Measure', 'Unit of measure.'],
    ],
  },
  NT: {
    name: 'Note / Reference Information',
    elements: [
      ['NT01', 'Code Qualifier Code', 'Qualifier for the note (9 = remarks).'],
      ['NT02', 'Code', 'Note code.'],
      ['NT03', 'Remarks', 'Free-text remark.'],
    ],
  },
  SBR: {
    name: 'Subrobage Information',
    elements: [
      ['SBR01', 'Patient Status Code', '9 = alive, 1 = deceased.'],
      ['SBR02', 'Patient Marital Status Code', '1 = married, 2 = single, etc.'],
      ['SBR03', 'Patient Sex Code', 'M = male, F = female.'],
      ['SBR04', 'Patient Birth Date', 'YYYYMMDD.'],
      ['SBR05', 'Patient Birth Time', 'Optional time of birth.'],
      ['SBR06', 'Patient Age', 'Patient age in years.'],
      ['SBR07', 'Patient Weight', 'Weight (lbs).'],
      ['SBR08', 'Patient Height', 'Height (inches).'],
      ['SBR09', 'Total Days in Hospital', 'Days in hospital.'],
      ['SBR10', 'Total Inpatient Days', 'Inpatient days.'],
      ['SBR11', 'Total Outpatient Days', 'Outpatient days.'],
    ],
  },
  BAI: {
    name: 'Billed/Assigned Information',
    elements: [
      ['BAI01', 'Claim Filing Indicator Code', 'Indicator of the claim filing type.'],
      ['BAI02', 'Claim File Indicator Code', '1 = original file, 2 = change file.'],
      ['BAI03', 'Claim Amount', 'Amount of the claim.'],
      ['BAI04', 'Charge Amount', 'Total charge amount.'],
      ['BAI05', 'Patient Amount', 'Amount billed to the patient.'],
      ['BAI06', 'Patient Payment Method Code', 'How the patient pays.'],
      ['BAI07', 'Patient Account Number', 'Patient account number.'],
      ['BAI08', 'Patient Last Updated Date', 'Date patient info was last updated.'],
      ['BAI09', 'Patient Last Updated Date Qualifier', 'Qualifier for the updated date.'],
    ],
  },
  FFS: {
    name: 'Fee For Service',
    elements: [
      ['FFS01', 'FFS Type Code', 'Type of fee-for-service coverage.'],
      ['FFS02', 'Payer Program ID', 'Payer program identifier.'],
      ['FFS03', 'Payer Program ID Qualifier', 'Qualifier for the program ID.'],
      ['FFS04', 'Patient Relationship Code', 'Patient relationship to insured.'],
      ['FFS05', 'Patient Relationship Code Qualifier', 'Qualifier for the relationship code.'],
      ['FFS06', 'Patient Account Number', 'Patient account number.'],
    ],
  },
  CAS: {
    name: 'Claim Adjustment Reason Code',
    elements: [
      ['CAS01', 'Cascode', 'Adjustment reason code (e.g. CO, PR, OA prefixes).'],
      ['CAS02', 'Code Qualifier', 'Qualifier for the cascode.'],
      ['CAS03', 'Date', 'Date of the adjustment.'],
      ['CAS04', 'Amount', 'Amount of the adjustment.'],
    ],
  },
  CUR: {
    name: 'Currency',
    elements: [
      ['CUR01', 'Currency Qualifier Code', 'Qualifier for the currency code.'],
      ['CUR02', 'Currency Code', 'Currency (e.g. USD).'],
    ],
  },
  REF: {
    name: 'Reference Identification',
    elements: [
      ['REF01', 'Reference Loop Qualifier', 'Loop the reference applies to (EI = ID number, FA = facility).'],
      ['REF02', 'Reference Identifier Qualifier Code', 'Qualifier for the reference ID.'],
      ['REF03', 'Reference ID', 'The reference value.'],
    ],
  },
  PER: {
    name: 'Administrative Communications',
    elements: [
      ['PER01', 'Code Qualifier', 'Role (IS = insured, LN = contact person, PD = professional).'],
      ['PER02', 'Name', 'Name of the person.'],
      ['PER03', 'Identification Code Qualifier', 'Qualifier for the person ID.'],
      ['PER04', 'Identification Code', 'Person ID value.'],
      ['PER05', 'Phone Number', 'Phone number.'],
      ['PER06', 'Phone Number Qualifier', 'Qualifier for the phone number.'],
    ],
  },
  N7: {
    name: 'Period of Time',
    elements: [
      ['N701', 'Period Code Qualifier', 'Qualifier describing the period.'],
      ['N702', 'Date From', 'Start date of the period.'],
      ['N703', 'Date To', 'End date of the period.'],
      ['N704', 'Frequency', 'Frequency of the period.'],
      ['N705', 'Frequency Basis Code', 'Basis of the frequency.'],
      ['N706', 'First Day of Week', 'First day of week.'],
      ['N707', 'Last Day of Week', 'Last day of week.'],
    ],
  },
  N8: {
    name: 'Employer/Payer Plan Information',
    elements: [
      ['N801', 'Code Qualifier', 'AB = plan, FA = facility, FF = ...'],
      ['N802', 'Name', 'Plan or facility name.'],
      ['N803', 'Identification Code Qualifier', 'Qualifier for the plan ID.'],
      ['N804', 'Identification Code', 'Plan ID value.'],
      ['N805', 'Program ID', 'Program identifier.'],
      ['N806', 'Program ID Qualifier', 'Qualifier for the program ID.'],
      ['N807', 'Sponsor Name', 'Sponsor name.'],
      ['N808', 'Sponsor Identification Code Qualifier', 'Qualifier for the sponsor ID.'],
      ['N809', 'Sponsor Identification Code', 'Sponsor ID value.'],
      ['N810', 'Group Number', 'Group number.'],
      ['N811', 'Plan Effective Date', 'Effective date of the plan.'],
      ['N812', 'Plan Expiration Date', 'Expiration date of the plan.'],
      ['N813', 'Coverage Description', 'Description of the coverage.'],
      ['N814', 'Plan Description', 'Description of the plan.'],
    ],
  },
  N9: {
    name: 'Procedure Information',
    elements: [
      ['N901', 'Service Type Code', '46 = evaluation and management.'],
      ['N902', 'Procedure Code', 'CPT / HCPCS code.'],
      ['N903', 'Procedure Code Modifier', 'Modifier for the procedure code.'],
    ],
  },
  RDM: {
    name: 'Release/Disposition Information',
    elements: [
      ['RDM01', 'Patient Disposition Code', 'How the patient was released/disposed of.'],
      ['RDM02', 'Patient Disposition Date', 'Date of disposition.'],
      ['RDM03', 'Patient Disposition Time', 'Time of disposition.'],
    ],
  },
  CQ1: {
    name: 'Quantity',
    elements: [
      ['CQ101', 'Quantity', 'Quantity value.'],
      ['CQ102', 'Unit of Measure', 'Unit of measure code.'],
    ],
  },
  EQT: {
    name: 'Equipment',
    elements: [
      ['EQT01', 'Equipment', 'Equipment code or ID.'],
      ['EQT02', 'Equipment Qualifier Code', 'Qualifier for the equipment.'],
    ],
  },
  LQ1: {
    name: 'Line Priced Unit Quantity',
    elements: [
      ['LQ101', 'Quantity', 'Quantity for the line.'],
      ['LQ102', 'Unit of Measure', 'Unit of measure code.'],
    ],
  },
  LQ2: {
    name: 'Line Adjustment Reason',
    elements: [
      ['LQ201', 'Adjustment Reason Code', 'Reason code for a line adjustment.'],
      ['LQ202', 'Adjustment Amount', 'Amount of the line adjustment.'],
    ],
  },
  AK1: {
    name: 'Acknowledgment of Interchange',
    elements: [
      ['AK101', 'Acknowledgment Type', '1 = accept, 2 = reject.'],
      ['AK102', 'Acknowledgment Reference Number', 'Reference to the acknowledged item.'],
      ['AK103', 'Acknowledgment Version', 'Version of the standard acknowledged.'],
      ['AK104', 'Reject Reason Code', 'Reason for rejection, if any.'],
      ['AK105', 'Reject Reason Code Qualifier', 'Qualifier for the reject reason.'],
    ],
  },
  AK3: {
    name: 'Acknowledgment of Functional Group',
    elements: [
      ['AK301', 'Acknowledgment Type', '1 = accept, 2 = reject.'],
      ['AK302', 'Acknowledgment Reference Number', 'Reference to the functional group.'],
      ['AK303', 'Acknowledgment Version', 'Version of the standard acknowledged.'],
      ['AK304', 'Reject Reason Code', 'Reason for rejection, if any.'],
      ['AK305', 'Reject Reason Code Qualifier', 'Qualifier for the reject reason.'],
    ],
  },
  AK4: {
    name: 'Acknowledgment of Transaction Set',
    elements: [
      ['AK401', 'Acknowledgment Type', '1 = accept, 2 = reject.'],
      ['AK402', 'Acknowledgment Reference Number', 'Reference to the transaction set.'],
      ['AK403', 'Reject Reason Code', 'Reason for rejection, if any.'],
      ['AK404', 'Reject Reason Code Qualifier', 'Qualifier for the reject reason.'],
    ],
  },
  CR1: {
    name: 'Change Reason',
    elements: [
      ['CR101', 'Change Reason Code', 'Reason the claim is being changed.'],
      ['CR102', 'Change Reason Code Qualifier', 'Qualifier for the change reason.'],
    ],
  },
  CR2: {
    name: 'Change Reason Detail',
    elements: [
      ['CR201', 'Code Qualifier', 'Qualifier for the change code.'],
      ['CR202', 'Code', 'Change code value.'],
      ['CR203', 'Code Qualifier 2', 'Second qualifier.'],
      ['CR204', 'Code 2', 'Second code value.'],
    ],
  },
  RFA: {
    name: 'Reason For Amount',
    elements: [
      ['RFA01', 'Reason Code', 'Reason associated with an amount.'],
      ['RFA02', 'Reason Code Qualifier', 'Qualifier for the reason code.'],
    ],
  },
};

/** Build the vector-DB chunks (one per segment spec). */
export function kbChunks(): KbChunk[] {
  return Object.keys(SEGMENTS).map((segId) => {
    const spec = SEGMENTS[segId];
    let text = 'SEG ' + segId + ' ' + spec.name;
    spec.elements.forEach((el, i) => {
      text += '\nEL ' + String(i + 1).padStart(2, '0') + ' ' + el[0] + ' ' + el[1] + ' :: ' + el[2];
    });
    return { segId, name: spec.name, text };
  });
}

/** Parse a KB chunk text back into a structured spec. */
export function parseKbChunk(text: string): ParsedSpec | null {
  const lines = String(text).split('\n');
  const header = lines[0].match(/^SEG\s+(\S+)\s+(.*)$/);
  if (!header) return null;
  const spec: ParsedSpec = { segId: header[1], name: header[2], elements: {} };
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^EL\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const sep = m[3].indexOf(' :: ');
    spec.elements[idx] = {
      code: m[2],
      name: sep >= 0 ? m[3].slice(0, sep) : m[3],
      desc: sep >= 0 ? m[3].slice(sep + 4) : '',
    };
  }
  return spec;
}

export { SEGMENTS };
