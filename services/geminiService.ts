
import { GoogleGenAI, Type, Modality, LiveServerMessage } from "@google/genai";
import { ConsultationDraft, Prescription } from "../types";

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 200): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const status = error?.status;
    const message = error?.message?.toLowerCase() || "";
    if (status === 429 || message.includes("quota") || message.includes("limit exceeded")) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        return withRetry(fn, retries - 1, delay * 2);
      }
      throw new QuotaError("System Busy. Processing in queue...");
    }
    throw error;
  }
}

export function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function createPcmBlob(data: Float32Array) {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Clean JSON response from potential markdown backticks
function cleanJsonResponse(text: string): string {
  return text.replace(/```json\n?|```/g, "").trim();
}

// Ultra-fast refinement for Unilingual transcription using Gemini 3
export async function refineToMedicalEnglish(text: string, fromLang: string): Promise<string> {
  if (!text.trim()) return "";
  return withRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: `Act as a Clinical Scribe Sanity Guard using Gemini 3 intelligence.
      Input Text: "${text}"
      Expected Language: ${fromLang}
      
      CORE TASK:
      1. SCRIPT SANITIZATION: If you see English medical terms written in local script, convert them immediately to standard Latin English ('Doctor', 'Paracetamol').
      2. TRANSLATION: Translate any actual ${fromLang} phrases to Professional Medical English.
      3. STANDARDIZATION: Clean up dosages and medicine frequencies.
      4. RETURN: Only the clean English text. No notes.` }] }],
      config: { thinkingConfig: { thinkingBudget: 0 } }
    });
    return response.text?.trim() || "";
  });
}

// Fast Translation + TTS for Bilingual sessions using Gemini 3 reasoning
export async function translateAndSpeak(text: string, from: string, to: string): Promise<{ translatedText: string, audioData: string }> {
  if (!text.trim()) return { translatedText: "", audioData: "" };
  return withRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const textResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: `Translate directly using Gemini 3: "${from}" to "${to}". If English appears in local script, fix it. Output ONLY translation. Text: "${text}"` }] }],
      config: { thinkingConfig: { thinkingBudget: 0 } }
    });
    const translatedText = textResponse.text?.trim() || "...";

    const audioResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: translatedText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const audioPart = audioResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    return { translatedText, audioData: audioPart?.inlineData?.data || "" };
  });
}

const SOAP_SYSTEM_PROMPT = `
Act as ClinicaFlow Elite AI Medical Scribe powered by Gemini 3.
Convert raw clinician-patient interaction transcripts into high-quality professional English SOAP summaries.
MANDATORY: 100% Latin Script (English). No local script characters allowed in final output.
Clean all phonetic drug names.
Return valid JSON only.
`;

// Final Analysis using Gemini 3 Flash for stability and speed
export async function processConsultation(transcript: string): Promise<ConsultationDraft> {
  if (!transcript.trim()) throw new Error("Empty transcript");
  return withRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Finalize this clinical record using Gemini 3 reasoning:\n${transcript}`,
      config: {
        systemInstruction: SOAP_SYSTEM_PROMPT,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            normalizedTranscript: { type: Type.STRING },
            demographics: {
              type: Type.OBJECT,
              properties: { name: { type: Type.STRING }, age: { type: Type.STRING }, gender: { type: Type.STRING } }
            },
            soap: {
              type: Type.OBJECT,
              properties: {
                subjective: { type: Type.STRING },
                objective: { type: Type.STRING },
                assessment: { type: Type.STRING },
                plan: { type: Type.STRING }
              },
              required: ["subjective", "objective", "assessment", "plan"]
            },
            prescriptions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  medicineName: { type: Type.STRING },
                  dosage: { type: Type.STRING },
                  morning: { type: Type.BOOLEAN },
                  afternoon: { type: Type.BOOLEAN },
                  evening: { type: Type.BOOLEAN },
                  night: { type: Type.BOOLEAN },
                  relationToFood: { type: Type.STRING, enum: ['Before Food', 'After Food'] },
                  duration: { type: Type.STRING }
                },
                required: ["medicineName", "dosage", "morning", "afternoon", "evening", "night", "relationToFood", "duration"]
              }
            },
            suggestedICD10: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: { code: { type: Type.STRING }, description: { type: Type.STRING } },
                required: ["code", "description"]
              }
            },
            doctorApprovalRequired: { type: Type.STRING }
          },
          required: ["normalizedTranscript", "soap", "prescriptions", "demographics", "suggestedICD10"]
        }
      }
    });
    
    const jsonStr = cleanJsonResponse(response.text || '{}');
    const draft = JSON.parse(jsonStr);
    return { ...draft, id: crypto.randomUUID(), date: new Date().toISOString() };
  });
}

// Medication safety verification using Gemini 3
export async function verifyMedication(med: Prescription): Promise<{ isValid: boolean, errorMsg?: string }> {
  return withRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Audit safety using Gemini 3: ${med.medicineName} ${med.dosage}. Return JSON.`,
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isValid: { type: Type.BOOLEAN },
            errorMsg: { type: Type.STRING }
          },
          required: ["isValid"]
        }
      }
    });
    const jsonStr = cleanJsonResponse(response.text || '{}');
    return JSON.parse(jsonStr);
  });
}

export function connectLiveSession(
  instruction: string,
  callbacks: {
    onInputTranscript: (text: string) => void,
    onError: (e: any) => void,
    onClose: () => void
  }
) {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  return ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      systemInstruction: instruction
    },
    callbacks: {
      onopen: () => console.debug('AuraDoc Gemini 3 Session Connected'),
      onmessage: async (message: LiveServerMessage) => {
        if (message.serverContent?.inputTranscription) {
          callbacks.onInputTranscript(message.serverContent.inputTranscription.text);
        }
      },
      onerror: (e: any) => {
        console.warn('Session Glitch (Non-fatal):', e);
        callbacks.onError(e);
      },
      onclose: (e: any) => callbacks.onClose(),
    }
  });
}
