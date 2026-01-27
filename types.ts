
export interface Message {
  role: 'Doctor' | 'Patient';
  original: string;
  translated?: string;
  timestamp: Date;
}

export interface ScribeBlock {
  original: string;
  refined?: string;
}

export interface Prescription {
  medicineName: string;
  dosage: string;
  morning: boolean;
  afternoon: boolean;
  evening: boolean;
  night: boolean;
  relationToFood: 'Before Food' | 'After Food';
  duration: string;
}

export interface ICD10Code {
  code: string;
  description: string;
}

export interface PatientDemographics {
  name: string;
  age: string;
  gender: string;
}

export interface SOAPSummary {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface ConsultationDraft {
  id: string;
  date: string;
  normalizedTranscript: string;
  demographics: PatientDemographics;
  soap: SOAPSummary;
  prescriptions: Prescription[];
  suggestedICD10: ICD10Code[];
  followUpRecommendation?: string;
  doctorApprovalRequired: string;
}

export enum AppStep {
  SPLASH = 'SPLASH',
  WELCOME = 'WELCOME',
  PATIENT_ENTRY = 'PATIENT_ENTRY',
  CAPTURE = 'CAPTURE',
  SUMMARY = 'SUMMARY',
  PRESCRIPTION = 'PRESCRIPTION',
  FINALIZE = 'FINALIZE',
  ARCHIVE = 'ARCHIVE'
}

export enum ConsultationMode {
  UNILINGUAL = 'UNILINGUAL',
  BILINGUAL = 'BILINGUAL'
}

export enum ProcessingStatus {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}
