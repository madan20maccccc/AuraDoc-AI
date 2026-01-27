
import React, { useState, useRef, useEffect } from 'react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { 
  processConsultation, 
  verifyMedication,
  translateAndSpeak,
  refineToMedicalEnglish,
  decode, 
  decodeAudioData,
  connectLiveSession,
  createPcmBlob
} from './services/geminiService';
import { ConsultationDraft, AppStep, ConsultationMode, Prescription, Message, ScribeBlock, ProcessingStatus, PatientDemographics } from './types';

interface VerifiedPrescription extends Prescription {
  verificationStatus?: 'Pending' | 'Verified' | 'Warning';
  verificationError?: string;
}

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>(AppStep.SPLASH);
  const [mode, setMode] = useState<ConsultationMode>(ConsultationMode.UNILINGUAL);
  const [docLang, setDocLang] = useState('English');
  const [patLang, setPatLang] = useState('Hindi');
  
  const [patientDetails, setPatientDetails] = useState<PatientDemographics>({
    name: '',
    age: '',
    gender: 'Male'
  });

  const [scribeBlocks, setScribeBlocks] = useState<ScribeBlock[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  
  const [draft, setDraft] = useState<ConsultationDraft | null>(null);
  const [archive, setArchive] = useState<ConsultationDraft[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState<'Doctor' | 'Patient' | 'Scribe' | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const currentRoleRef = useRef<'Doctor' | 'Patient' | 'Scribe' | null>(null);
  const capturedTextRef = useRef<string>('');
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, scribeBlocks, currentInput]);

  useEffect(() => {
    const saved = localStorage.getItem('auradoc_ai_vault_v1');
    if (saved) {
      try { setArchive(JSON.parse(saved)); } catch (e) { console.error(e); }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('auradoc_ai_vault_v1', JSON.stringify(archive));
  }, [archive]);

  const cleanupSession = async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (sessionRef.current) {
      const session = await sessionRef.current;
      try { session.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (audioContextRef.current) {
      try { if (audioContextRef.current.state !== 'closed') await audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }
  };

  const resetAllState = async () => {
    await cleanupSession();
    setStep(AppStep.WELCOME);
    setScribeBlocks([]);
    setMessages([]);
    setDraft(null);
    setCurrentInput('');
    setError(null);
    setPatientDetails({ name: '', age: '', gender: 'Male' });
    capturedTextRef.current = '';
    currentRoleRef.current = null;
    setIsTranslating(false);
    setIsFinalizing(false);
    setIsLive(null);
    setStatus(ProcessingStatus.IDLE);
  };

  const stopLiveSession = async () => {
    const role = currentRoleRef.current;
    setIsFinalizing(true);
    await new Promise(r => setTimeout(r, 400));
    const finalCaptured = capturedTextRef.current.trim();
    await cleanupSession();
    setIsLive(null);
    currentRoleRef.current = null;
    capturedTextRef.current = '';
    setIsFinalizing(false);
    setCurrentInput('');

    if (!finalCaptured) return;

    if (mode === ConsultationMode.BILINGUAL && (role === 'Doctor' || role === 'Patient')) {
      handleTranslationPhase(role as 'Doctor' | 'Patient', finalCaptured);
    } else {
      const newBlock: ScribeBlock = { original: finalCaptured };
      setScribeBlocks(prev => [...prev, newBlock]);
      try {
        const refined = await refineToMedicalEnglish(finalCaptured, docLang);
        setScribeBlocks(prev => prev.map(b => b.original === finalCaptured ? { ...b, refined } : b));
      } catch(e) { console.error(e); }
    }
  };

  const handleTranslationPhase = async (role: 'Doctor' | 'Patient', text: string) => {
    setIsTranslating(true);
    try {
      const from = role === 'Doctor' ? docLang : patLang;
      const to = role === 'Doctor' ? patLang : docLang;
      const result = await translateAndSpeak(text, from, to);
      const newMsg: Message = { role, original: text, translated: result.translatedText, timestamp: new Date() };
      setMessages(prev => [...prev, newMsg]);
      if (result.audioData) {
        const playCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = await decodeAudioData(decode(result.audioData), playCtx, 24000, 1);
        const source = playCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(playCtx.destination);
        source.onended = () => playCtx.close();
        source.start(0);
      }
    } catch (e) { console.error(e); } finally { setIsTranslating(false); }
  };

  const toggleMic = async (role: 'Doctor' | 'Patient' | 'Scribe') => {
    if (isLive === role) { await stopLiveSession(); return; }
    if (isLive) await stopLiveSession();
    setError(null);
    setCurrentInput('');
    capturedTextRef.current = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (audioContext.state === 'suspended') await audioContext.resume();
      audioContextRef.current = audioContext;
      currentRoleRef.current = role;

      const targetLang = role === 'Patient' ? patLang : docLang;

      const instruction = `URGENT SCRIPT LOCK (Role: ${role}):
      1. Expected Language: "${targetLang}".
      2. RULE: If user speaks English words, you MUST use English (Latin) script.
      3. FORBIDDEN: NEVER use local script for English medical words (e.g. NEVER 'डॉ क्टर', use 'Doctor').
      4. DO NOT translate. DO NOT interpret. Only raw speech-to-script.`;
      
      const sessionPromise = connectLiveSession(instruction, {
        onInputTranscript: (text) => {
          capturedTextRef.current += (capturedTextRef.current ? ' ' : '') + text;
          setCurrentInput(prev => (prev ? prev + ' ' : '') + text);
        },
        onError: (e) => console.debug("Sync glitch..."),
        onClose: () => console.debug("Session finalized.")
      });
      sessionRef.current = sessionPromise;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm = createPcmBlob(inputData);
        sessionPromise.then(session => { if (session) session.sendRealtimeInput({ media: pcm }); }).catch(() => {});
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      setIsLive(role);
    } catch (err) { setError("Microphone access restricted."); }
  };

  const handleVerifyMedicine = async (idx: number) => {
    if (!draft) return;
    const newList = [...draft.prescriptions];
    (newList[idx] as VerifiedPrescription).verificationStatus = 'Pending';
    setDraft({ ...draft, prescriptions: newList });
    try {
      const result = await verifyMedication(draft.prescriptions[idx]);
      const updatedList = [...draft.prescriptions];
      (updatedList[idx] as VerifiedPrescription).verificationStatus = result.isValid ? 'Verified' : 'Warning';
      (updatedList[idx] as VerifiedPrescription).verificationError = result.errorMsg;
      setDraft({ ...draft, prescriptions: updatedList });
    } catch (e) {
      const errorList = [...draft.prescriptions];
      (errorList[idx] as VerifiedPrescription).verificationStatus = 'Warning';
      (errorList[idx] as VerifiedPrescription).verificationError = "Audit timeout.";
      setDraft({ ...draft, prescriptions: errorList });
    }
  };

  const handleAnalyze = async () => {
    if (isLive) await stopLiveSession();
    setStatus(ProcessingStatus.PROCESSING);
    setError(null);
    const transcriptText = mode === ConsultationMode.UNILINGUAL 
      ? scribeBlocks.map(b => `${b.original} (Refined: ${b.refined})`).join('\n')
      : messages.map(m => `${m.role}: ${m.original} (interpreted: ${m.translated})`).join('\n');
    try {
      const res = await processConsultation(transcriptText);
      res.demographics = patientDetails;
      setDraft(res);
      setStep(AppStep.SUMMARY);
    } catch (e) { setError("AI analysis error."); } finally { setStatus(ProcessingStatus.IDLE); }
  };

  const handleWhatsAppShare = () => {
    if (!draft) return;
    const text = encodeURIComponent(`
*AuraDoc AI Clinical Report*
*Patient:* ${draft.demographics.name}
*Date:* ${new Date(draft.date).toLocaleDateString()}

*SOAP Summary:*
- Subjective: ${draft.soap.subjective}
- Objective: ${draft.soap.objective}
- Assessment: ${draft.soap.assessment}
- Plan: ${draft.soap.plan}

*Prescriptions:*
${draft.prescriptions.map(p => `• ${p.medicineName} (${p.dosage}) - ${p.duration}`).join('\n')}

_Authorized via AuraDoc AI Engine_
    `.trim());
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const downloadPDF = async () => {
    if (!reportRef.current) return;
    setIsDownloading(true);
    try {
      const canvas = await html2canvas(reportRef.current, { scale: 1.5, useCORS: true });
      const imgData = canvas.toDataURL('image/png', 0.8);
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      pdf.save(`AuraDoc_${patientDetails.name.replace(/\s+/g, '_')}.pdf`);
    } catch (e) { setError("PDF build issue."); } finally { setIsDownloading(false); }
  };

  const copyToClipboard = () => {
    if (!draft) return;
    setIsCopying(true);
    const text = `AuraDoc AI Case Record: ${draft.demographics.name}\n${draft.soap.assessment}\n\nPlan: ${draft.soap.plan}`;
    navigator.clipboard.writeText(text).then(() => setTimeout(() => setIsCopying(false), 2000));
  };

  const languages = ["English", "Tamil", "Hindi", "Telugu", "Malayalam", "Kannada", "Spanish", "French", "Arabic"];

  const AuraLogo = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
    const scale = size === "lg" ? 1.5 : size === "md" ? 1 : 0.6;
    return (
      <div className="flex flex-col items-center">
        <svg width={80 * scale} height={80 * scale} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Half Circle Aura */}
          <path d="M10 60C10 37.9086 27.9086 20 50 20C72.0914 20 90 37.9086 90 60" stroke="url(#paint0_linear)" strokeWidth="2" strokeLinecap="round"/>
          
          {/* Doctor Silhouette */}
          <path d="M25 75C25 68 30 63 35 60C32 58 30 55 30 51C30 46 33 42 38 42C43 42 46 46 46 51C46 55 44 58 41 60C46 63 51 68 51 75" fill="#003366"/>
          <path d="M30 65C30 67 33 70 38 70C43 70 46 67 46 65" stroke="#003366" strokeWidth="1.5"/>
          
          {/* Patient Silhouette */}
          <path d="M75 75C75 68 70 63 65 60C68 58 70 55 70 51C70 46 67 42 62 42C57 42 54 46 54 51C54 55 56 58 59 60C54 63 49 68 49 75" fill="#FF6600"/>

          {/* Speech Bubbles */}
          <path d="M45 40C45 35 48 32 52 32H60C64 32 67 35 67 40V43C67 46 65 48 62 48L59 52V48H52C48 48 45 45 45 40Z" fill="#009933" opacity="0.8"/>
          <text x="50" y="42" fill="white" fontSize="8" fontWeight="bold">A</text>
          <text x="58" y="42" fill="white" fontSize="8" fontWeight="bold">अ</text>

          <defs>
            <linearGradient id="paint0_linear" x1="10" y1="40" x2="90" y2="40" gradientUnits="userSpaceOnUse">
              <stop stopColor="#003366"/>
              <stop offset="0.5" stopColor="#FF6600"/>
              <stop offset="1" stopColor="#009933"/>
            </linearGradient>
          </defs>
        </svg>
        <div className={`font-black tracking-tighter text-center ${size === "lg" ? "text-4xl" : size === "md" ? "text-xl" : "text-sm"}`}>
          <span className="text-[#003366]">AuraDoc</span> <span className="text-[#009933]">AI</span>
        </div>
      </div>
    );
  };

  const MicIcon = ({ active = false, size = "md" }: { active?: boolean, size?: "md" | "lg" }) => {
    const s = size === "lg" ? "w-10 h-10" : "w-6 h-6";
    return (
      <svg className={`${s} transition-all duration-300 ${active ? 'scale-110' : 'scale-100'}`} fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>
    );
  };

  return (
    <div className="min-h-screen bg-[#f9fafc] text-slate-900 selection:bg-blue-100 selection:text-blue-900">
      <div className={`h-1 fixed top-0 w-full z-[250] transition-all duration-500 ${isLive ? 'bg-red-500 animate-pulse' : isTranslating ? 'bg-green-500 animate-pulse' : 'bg-transparent'}`} />

      {step === AppStep.SPLASH ? (
        <div className="fixed inset-0 bg-white z-[300] flex flex-col items-center justify-center animate-in fade-in duration-1000">
          <div className="flex flex-col items-center space-y-12 animate-in slide-in-from-bottom-8 duration-700">
             <AuraLogo size="lg" />
             <div className="h-1.5 w-32 bg-slate-50 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[#003366] via-[#FF6600] to-[#009933] animate-progress origin-left" />
             </div>
             <div className="text-center space-y-2">
               <p className="text-slate-400 font-bold uppercase tracking-[0.4em] text-[10px]">Empowering Clinical Precision</p>
               <p className="text-slate-300 font-medium text-[9px] uppercase tracking-[0.2em]">Medical Intelligence System v1.0</p>
             </div>
             <button onClick={() => setStep(AppStep.WELCOME)} className="px-12 py-5 bg-[#003366] text-white font-black rounded-2xl text-sm uppercase tracking-widest hover:bg-[#002244] transition-all shadow-xl shadow-blue-100 transform active:scale-95">Initiate Intake</button>
          </div>
        </div>
      ) : (
        <>
          <header className="h-20 bg-white/80 backdrop-blur-md border-b border-slate-100 flex items-center px-10 justify-between sticky top-0 z-[100] no-print">
            <div className="cursor-pointer transition-all hover:scale-105 active:scale-95 flex items-center gap-3" onClick={resetAllState}>
              <AuraLogo size="sm" />
            </div>
            <div className="flex items-center gap-6">
               <button onClick={() => setStep(AppStep.ARCHIVE)} className="text-[10px] font-black uppercase text-slate-400 tracking-[0.1em] hover:text-[#003366] transition-colors">Vault ({archive.length})</button>
               <button onClick={resetAllState} className="text-[10px] font-black uppercase text-red-500 tracking-[0.1em] px-4 py-2 bg-red-50/50 rounded-lg hover:bg-red-100 transition-all border border-red-100/50">Emergency Reset</button>
            </div>
          </header>

          <main className="max-w-5xl mx-auto py-10 px-8">
            {error && <div className="mb-6 p-4 bg-red-50 text-red-900 border-l-[4px] border-red-500 rounded-lg text-sm font-bold shadow-sm">{error}</div>}

            {step === AppStep.WELCOME && (
              <div className="max-w-4xl mx-auto py-12 text-center space-y-12 animate-in fade-in slide-in-from-bottom-6 duration-700">
                <div className="space-y-6">
                  <span className="px-5 py-2 bg-[#003366]/5 text-[#003366] rounded-full text-[10px] font-black uppercase tracking-[0.2em] border border-[#003366]/10 shadow-sm">Healthcare Transcription Engine</span>
                  <h2 className="text-5xl font-black text-slate-900 tracking-tighter leading-tight">Elite Documentation <br/><span className="bg-gradient-to-r from-[#003366] via-[#FF6600] to-[#009933] bg-clip-text text-transparent">Reimagined for Clinicians.</span></h2>
                  <p className="text-slate-500 text-lg font-medium max-w-2xl mx-auto leading-relaxed">AuraDoc AI listens, interprets, and structures your patient encounters with military-grade precision and zero latency.</p>
                </div>
                
                <div className="grid md:grid-cols-2 gap-10 pt-6">
                  <div onClick={() => { setMode(ConsultationMode.UNILINGUAL); setStep(AppStep.PATIENT_ENTRY); }} className="p-10 bg-white rounded-[32px] shadow-xl shadow-slate-200/40 hover:shadow-blue-500/10 hover:scale-[1.02] border border-slate-50 hover:border-[#003366]/30 cursor-pointer transition-all text-left group">
                    <div className="w-12 h-12 bg-blue-50 text-[#003366] rounded-xl flex items-center justify-center mb-6 group-hover:rotate-6 transition-transform shadow-inner"><MicIcon /></div>
                    <h3 className="text-2xl font-black mb-2 text-slate-800 tracking-tight">Vocal Scribe</h3>
                    <p className="text-slate-500 text-sm font-semibold leading-relaxed">Direct clinical transcription with real-time medical script guarding and SOAP structuring.</p>
                  </div>
                  
                  <div onClick={() => { setMode(ConsultationMode.BILINGUAL); setStep(AppStep.PATIENT_ENTRY); }} className="p-10 bg-white rounded-[32px] shadow-xl shadow-slate-200/40 hover:shadow-green-500/10 hover:scale-[1.02] border border-slate-50 hover:border-[#009933]/30 cursor-pointer transition-all text-left group">
                    <div className="w-12 h-12 bg-green-50 text-[#009933] rounded-xl flex items-center justify-center mb-6 group-hover:-rotate-6 transition-transform shadow-inner"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 11.37 9.188 16.5 6 16.5"/></svg></div>
                    <h3 className="text-2xl font-black mb-2 text-slate-800 tracking-tight">Smart Interpreter</h3>
                    <p className="text-slate-500 text-sm font-semibold leading-relaxed">Low-latency voice-to-voice interpretation between clinicians and multilingual patients.</p>
                  </div>
                </div>
              </div>
            )}

            {step === AppStep.PATIENT_ENTRY && (
              <div className="max-w-xl mx-auto animate-in fade-in zoom-in-95 duration-500">
                <div className="bg-white rounded-[32px] shadow-2xl border border-slate-100 p-12">
                  <h2 className="text-3xl font-black text-slate-900 mb-2 tracking-tighter text-[#003366]">Patient Registry</h2>
                  <p className="text-slate-400 text-sm font-medium mb-10 tracking-tight">Identity verification for the clinical documentation phase.</p>
                  
                  <div className="space-y-6">
                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-300 tracking-[0.2em] mb-2 ml-2">Full Legal Name</label>
                      <input type="text" value={patientDetails.name} onChange={(e) => setPatientDetails({...patientDetails, name: e.target.value})} placeholder="e.g. Madan Kumar" className="w-full bg-slate-50/50 p-4 rounded-xl border-none ring-1 ring-slate-100 focus:ring-2 focus:ring-[#003366] outline-none font-bold text-lg" />
                    </div>
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <label className="block text-[10px] font-black uppercase text-slate-300 tracking-[0.2em] mb-2 ml-2">Age</label>
                        <input type="text" value={patientDetails.age} onChange={(e) => setPatientDetails({...patientDetails, age: e.target.value})} placeholder="35" className="w-full bg-slate-50/50 p-4 rounded-xl border-none ring-1 ring-slate-100 focus:ring-2 focus:ring-[#003366] outline-none font-bold text-lg" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-black uppercase text-slate-300 tracking-[0.2em] mb-2 ml-2">Gender</label>
                        <select value={patientDetails.gender} onChange={(e) => setPatientDetails({...patientDetails, gender: e.target.value})} className="w-full bg-slate-50/50 p-4 rounded-xl border-none ring-1 ring-slate-100 focus:ring-2 focus:ring-[#003366] outline-none font-bold text-lg cursor-pointer">
                          <option>Male</option><option>Female</option><option>Other</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="mt-12 flex gap-4">
                    <button onClick={() => setStep(AppStep.WELCOME)} className="px-8 py-4 text-slate-400 font-bold uppercase text-[10px] tracking-[0.1em] hover:text-slate-600">Back</button>
                    <button disabled={!patientDetails.name} onClick={() => setStep(AppStep.CAPTURE)} className="flex-1 py-4 bg-[#003366] text-white font-black rounded-xl text-lg shadow-xl shadow-slate-100 hover:scale-[1.02] active:scale-95 disabled:opacity-20 transition-all">Begin Capture</button>
                  </div>
                </div>
              </div>
            )}

            {step === AppStep.CAPTURE && (
              <div className="animate-in fade-in duration-500 max-w-5xl mx-auto">
                 <div className="bg-white rounded-[32px] shadow-2xl border border-slate-100 p-8">
                    <div className="flex flex-col md:flex-row justify-between items-center pb-6 border-b border-slate-50 gap-4 mb-8">
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full ${isLive ? 'bg-red-500 animate-pulse shadow-lg shadow-red-100' : 'bg-[#009933] shadow-lg shadow-green-100'}`} />
                        <h2 className="text-2xl font-black text-slate-900 tracking-tighter">{patientDetails.name} <span className="text-slate-300 font-medium ml-2 text-base">Active Encounter</span></h2>
                      </div>
                      <div className="flex gap-3">
                         <select value={docLang} onChange={e => setDocLang(e.target.value)} className="bg-slate-50/80 px-4 py-2 rounded-xl font-black text-[10px] text-[#003366] uppercase tracking-widest border border-slate-100 outline-none focus:ring-2 ring-[#003366]">{languages.map(l => <option key={l}>{l}</option>)}</select>
                         {mode === ConsultationMode.BILINGUAL && (
                           <select value={patLang} onChange={e => setPatLang(e.target.value)} className="bg-slate-50/80 px-4 py-2 rounded-xl font-black text-[10px] text-[#FF6600] uppercase tracking-widest border border-slate-100 outline-none focus:ring-2 ring-[#FF6600]">{languages.map(l => <option key={l}>{l}</option>)}</select>
                         )}
                      </div>
                    </div>

                    <div className="flex flex-col lg:flex-row gap-10">
                       <div className="lg:w-[32%] flex flex-col items-center gap-8">
                          {mode === ConsultationMode.UNILINGUAL ? (
                            <div className="flex flex-col items-center gap-6 w-full py-4">
                               <div className="relative group">
                                  <div className={`absolute -inset-8 bg-red-500/10 rounded-full blur-2xl transition-all duration-700 ${isLive === 'Scribe' ? 'opacity-100 animate-pulse' : 'opacity-0'}`} />
                                  <button onClick={() => toggleMic('Scribe')} className={`relative w-48 h-48 rounded-full border-[10px] transition-all flex flex-col items-center justify-center shadow-2xl active:scale-95 ${isLive === 'Scribe' ? 'bg-white border-red-500 text-red-500' : 'bg-[#003366] border-white text-white hover:scale-105'}`}>
                                     <MicIcon size="lg" active={isLive === 'Scribe'} />
                                     <span className="font-black text-[10px] tracking-[0.2em] mt-3 uppercase">{isLive === 'Scribe' ? 'HALT' : 'RECORD'}</span>
                                  </button>
                               </div>
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">{isLive ? 'Analyzing Audio Stream...' : 'System Standing By'}</p>
                            </div>
                          ) : (
                            <div className="space-y-6 w-full">
                               <button onClick={() => toggleMic('Doctor')} className={`group relative w-full p-8 rounded-2xl border-2 transition-all flex flex-col items-center gap-4 shadow-xl active:scale-95 ${isLive === 'Doctor' ? 'bg-white border-red-500' : 'bg-[#003366]/5 border-slate-50 hover:border-[#003366]/30'}`}>
                                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105 ${isLive === 'Doctor' ? 'bg-red-500 text-white shadow-xl shadow-red-100' : 'bg-[#003366] text-white shadow-xl shadow-blue-100'}`}><MicIcon /></div>
                                  <span className="font-black text-slate-900 text-sm tracking-tight">Doctor ({docLang})</span>
                               </button>
                               
                               <button onClick={() => toggleMic('Patient')} className={`group relative w-full p-8 rounded-2xl border-2 transition-all flex flex-col items-center gap-4 shadow-xl active:scale-95 ${isLive === 'Patient' ? 'bg-white border-red-500' : 'bg-[#FF6600]/5 border-slate-50 hover:border-[#FF6600]/30'}`}>
                                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105 ${isLive === 'Patient' ? 'bg-red-500 text-white shadow-xl shadow-red-100' : 'bg-[#FF6600] text-white shadow-xl shadow-orange-100'}`}><MicIcon /></div>
                                  <span className="font-black text-slate-900 text-sm tracking-tight">Patient ({patLang})</span>
                               </button>
                            </div>
                          )}
                       </div>

                       <div className="lg:w-[68%] bg-slate-50/50 rounded-[24px] p-6 h-[500px] overflow-hidden border border-slate-100 shadow-inner relative flex flex-col">
                          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-6 pr-2">
                             {mode === ConsultationMode.UNILINGUAL ? (
                                scribeBlocks.length > 0 ? scribeBlocks.map((b, i) => (
                                   <div key={i} className="animate-in slide-in-from-bottom-2 duration-300">
                                      <p className="text-xl font-bold text-slate-800 leading-relaxed tracking-tight">{b.original}</p>
                                      <div className="mt-3 ml-4 p-4 bg-white rounded-xl border border-blue-50/50 flex items-start gap-4 shadow-sm">
                                         <div className="text-[9px] font-black text-[#003366] mt-1 uppercase tracking-tighter">Verified Script:</div>
                                         <p className="text-base font-bold text-[#003366] italic leading-snug">{b.refined || 'Scrubbing dialogue...'}</p>
                                      </div>
                                   </div>
                                )) : <div className="h-full flex flex-col items-center justify-center opacity-30 text-slate-400 gap-6 text-center px-12 animate-pulse"><MicIcon size="lg" /> <p className="text-lg font-bold">Waiting for Consultation Audio...</p></div>
                             ) : (
                                messages.length > 0 ? messages.map((m, i) => (
                                   <div key={i} className={`flex flex-col ${m.role === 'Doctor' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                                     <div className={`max-w-[85%] p-5 rounded-2xl shadow-lg ${m.role === 'Doctor' ? 'bg-[#003366] text-white rounded-tr-none' : 'bg-[#FF6600] text-white rounded-tl-none'}`}>
                                       <span className="text-[9px] font-black uppercase tracking-[0.2em] mb-1.5 opacity-70 block">{m.role}</span>
                                       <p className="text-lg font-bold leading-tight tracking-tight mb-3">{m.original}</p>
                                       <div className="mt-2 pt-2 border-t border-white/20 text-sm font-semibold italic opacity-90 leading-relaxed">Interpretation: {m.translated}</div>
                                     </div>
                                   </div>
                                )) : <div className="h-full flex flex-col items-center justify-center opacity-30 text-slate-400 gap-6 text-center px-12 animate-pulse"><svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg> <p className="text-lg font-bold">AuraDoc Interpreter Standing By...</p></div>
                             )}
                             {currentInput && (
                               <div className="animate-in slide-in-from-bottom-2 p-4 bg-white border border-slate-100 rounded-xl text-slate-500 italic text-lg font-bold shadow-sm ring-4 ring-blue-50/30">
                                  "{currentInput}..."
                               </div>
                             )}
                             <div ref={chatEndRef} />
                          </div>
                       </div>
                    </div>

                    <div className="mt-8 flex gap-6 items-center">
                      <button onClick={resetAllState} className="px-8 py-4 text-slate-400 font-bold uppercase text-[10px] tracking-[0.1em] hover:text-red-600 transition-all">Abort Session</button>
                      <button onClick={handleAnalyze} disabled={status === ProcessingStatus.PROCESSING || (scribeBlocks.length === 0 && messages.length === 0)} className="flex-1 py-5 bg-[#009933] text-white font-black rounded-2xl text-xl shadow-2xl shadow-green-100 hover:scale-[1.01] active:scale-95 disabled:grayscale transition-all">
                        {status === ProcessingStatus.PROCESSING ? 'AuraDoc is Thinking...' : 'Structure Documentation'}
                      </button>
                    </div>
                 </div>
              </div>
            )}

            {step === AppStep.ARCHIVE && (
              <div className="animate-in fade-in duration-500 space-y-8">
                 <div className="flex justify-between items-center border-b border-slate-200 pb-6">
                    <h2 className="text-3xl font-black text-slate-900 tracking-tighter">Clinical Vault</h2>
                    <button onClick={() => setStep(AppStep.WELCOME)} className="text-[10px] font-black uppercase text-[#003366] tracking-[0.2em] px-6 py-3 bg-[#003366]/5 rounded-lg hover:bg-[#003366]/10 transition-all">Home Portal</button>
                 </div>
                 {archive.length === 0 ? (
                   <div className="py-24 bg-white rounded-3xl text-center italic text-slate-300 border border-slate-100 text-xl font-bold">No clinical records in the vault.</div>
                 ) : (
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                     {archive.map((s) => (
                       <div key={s.id} className="bg-white p-8 rounded-[24px] shadow-xl border border-slate-100 hover:border-[#003366] hover:translate-y-[-4px] transition-all flex flex-col h-full group">
                          <div className="flex justify-between mb-4">
                            <span className="text-[10px] font-black bg-slate-50 text-slate-500 px-3 py-1 rounded uppercase tracking-widest">{new Date(s.date).toLocaleDateString()}</span>
                            <div className="w-2 h-2 rounded-full bg-[#009933] shadow-lg shadow-green-200"></div>
                          </div>
                          <h4 className="text-xl font-black text-slate-800 tracking-tight leading-none mb-4 flex-1">{s.demographics.name} <span className="block text-slate-400 font-black text-sm mt-2">{s.soap.assessment}</span></h4>
                          <button onClick={() => { setDraft(s); setStep(AppStep.FINALIZE); }} className="w-full py-4 bg-[#003366] text-white rounded-xl font-black text-[10px] uppercase tracking-[0.2em] hover:bg-[#002244] transition-all">Access File</button>
                       </div>
                     ))}
                   </div>
                 )}
              </div>
            )}

            {step === AppStep.SUMMARY && draft && (
              <div className="animate-in fade-in zoom-in-95 duration-700">
                 <div className="flex justify-between items-end mb-8">
                    <h2 className="text-3xl font-black text-slate-900 tracking-tighter">SOAP Analysis</h2>
                    <div className="px-4 py-1.5 bg-[#003366]/5 text-[#003366] rounded-lg text-[10px] font-black uppercase tracking-[0.2em] border border-[#003366]/10">Clinical Draft</div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
                    <div className="md:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">
                       {['subjective', 'objective', 'assessment', 'plan'].map((field) => (
                         <div key={field} className="bg-white rounded-[24px] p-6 shadow-xl border border-slate-100 group transition-all hover:border-[#003366]/30">
                            <label className="text-[11px] font-black uppercase text-slate-400 tracking-[0.2em] group-hover:text-[#003366] block mb-3 ml-1">{field}</label>
                            <textarea 
                              value={(draft.soap as any)[field]} 
                              onChange={e => setDraft({...draft, soap: {...draft.soap, [field]: e.target.value}})} 
                              className="w-full bg-slate-50/50 p-4 rounded-xl border-none text-base font-bold min-h-[160px] focus:ring-4 ring-[#003366]/10 transition-all text-slate-700 shadow-inner resize-none" 
                            />
                         </div>
                       ))}
                    </div>
                    <div className="md:col-span-4 space-y-6">
                       <div className="bg-[#003366] rounded-[24px] p-8 shadow-2xl text-white space-y-8 border border-white/5">
                          <h4 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.3em] text-center">Diagnostic Codes (ICD-10)</h4>
                          <div className="space-y-4">
                             {draft.suggestedICD10.map((icd, i) => (
                               <div key={i} className="p-4 bg-white/5 rounded-xl border border-white/5 hover:border-[#009933]/50 transition-all cursor-pointer">
                                  <span className="text-[10px] font-black bg-[#009933] px-3 py-1.5 rounded text-white shadow-lg shadow-green-600/30 inline-block">{icd.code}</span>
                                  <p className="mt-3 text-sm font-bold leading-tight tracking-tight text-white/95">{icd.description}</p>
                               </div>
                             ))}
                          </div>
                       </div>
                       <button onClick={() => setStep(AppStep.PRESCRIPTION)} className="w-full py-6 bg-[#003366] text-white font-black rounded-2xl text-xl shadow-2xl shadow-blue-200 hover:scale-[1.02] transition-all">Proceed to Medication</button>
                    </div>
                 </div>
              </div>
            )}

            {step === AppStep.PRESCRIPTION && draft && (
              <div className="animate-in fade-in duration-500 max-w-4xl mx-auto">
                 <div className="bg-white rounded-[32px] shadow-2xl p-8 border border-slate-100">
                    <div className="flex justify-between items-center mb-8">
                       <h2 className="text-3xl font-black text-slate-900 tracking-tighter text-[#003366]">Prescription Pad</h2>
                       <button onClick={() => {
                         const med: VerifiedPrescription = { medicineName: '', dosage: '', morning: true, afternoon: false, evening: false, night: true, relationToFood: 'After Food', duration: '5 Days' };
                         setDraft({...draft, prescriptions: [...draft.prescriptions, med]});
                       }} className="px-6 py-3 bg-[#003366] text-white rounded-lg font-black text-[10px] shadow-lg uppercase tracking-widest transition-all hover:bg-[#002244]">+ New Item</button>
                    </div>
                    <div className="space-y-6">
                      {draft.prescriptions.map((p: VerifiedPrescription, idx) => (
                        <div key={idx} className={`rounded-3xl p-6 border-2 transition-all shadow-sm ${p.verificationStatus === 'Warning' ? 'bg-red-50/50 border-red-200' : 'bg-slate-50/30 border-slate-100'}`}>
                           <div className="flex justify-between mb-6 items-start">
                              <div className="flex-1">
                                <input value={p.medicineName} onChange={e => { const list = [...draft.prescriptions]; list[idx].medicineName = e.target.value; setDraft({...draft, prescriptions: list}); }} className="bg-transparent text-3xl font-black outline-none w-full placeholder-slate-200 text-slate-900 tracking-tighter" placeholder="Medication Name..." />
                                {p.verificationStatus && (
                                  <div className={`mt-3 flex items-center gap-3 ${p.verificationStatus === 'Verified' ? 'text-green-600' : 'text-red-600'}`}>
                                    <span className="text-[10px] font-black uppercase tracking-[0.1em] bg-white px-3 py-1.5 rounded-lg shadow-md border border-slate-100">
                                      {p.verificationStatus === 'Verified' ? '✓ Clinical Safety Verified' : `⚠ AUDIT WARNING: ${p.verificationError}`}
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="flex gap-3">
                                <button onClick={() => handleVerifyMedicine(idx)} className="text-[11px] font-black uppercase text-[#003366] bg-white px-5 py-2.5 rounded-lg shadow-md border border-slate-100 hover:shadow-blue-100">Audit</button>
                                <button onClick={() => { const list = [...draft.prescriptions]; list.splice(idx,1); setDraft({...draft, prescriptions: list}); }} className="text-[11px] font-black uppercase text-red-300 px-4 hover:text-red-600">Remove</button>
                              </div>
                           </div>
                           <div className="grid md:grid-cols-4 gap-6">
                              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-300 tracking-[0.1em] ml-2">Dose</label><input value={p.dosage} onChange={e => { const list = [...draft.prescriptions]; list[idx].dosage = e.target.value; setDraft({...draft, prescriptions: list}); }} className="w-full bg-white p-3 rounded-xl font-black text-lg border-none shadow-xl shadow-slate-100/50" /></div>
                              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-300 tracking-[0.1em] ml-2">Timing</label><select value={p.relationToFood} onChange={e => { const list = [...draft.prescriptions]; list[idx].relationToFood = e.target.value as any; setDraft({...draft, prescriptions: list}); }} className="w-full bg-white p-3 rounded-xl font-black text-lg border-none shadow-xl shadow-slate-100/50 outline-none cursor-pointer"><option>After Food</option><option>Before Food</option></select></div>
                              <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-300 tracking-[0.1em] ml-2">Dur.</label><input value={p.duration} onChange={e => { const list = [...draft.prescriptions]; list[idx].duration = e.target.value; setDraft({...draft, prescriptions: list}); }} className="w-full bg-white p-3 rounded-xl font-black text-lg border-none shadow-xl shadow-slate-100/50" /></div>
                              <div className="space-y-2">
                                 <label className="text-[10px] font-black uppercase text-slate-300 tracking-[0.1em] ml-2">Freq</label>
                                 <div className="flex gap-1.5">
                                   {['M', 'A', 'E', 'N'].map((t, i) => {
                                     const k = ['morning','afternoon','evening','night'][i] as keyof Prescription;
                                     return <button key={t} onClick={() => { const list = [...draft.prescriptions]; (list[idx] as any)[k] = !list[idx][k]; setDraft({...draft, prescriptions: list}); }} className={`w-8 h-8 rounded-lg font-black text-[10px] transition-all shadow-xl active:scale-90 ${p[k] ? 'bg-[#003366] text-white shadow-blue-200' : 'bg-white text-slate-200 hover:text-slate-400'}`}>{t}</button>
                                   })}
                                 </div>
                              </div>
                           </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-12 flex gap-8">
                      <button onClick={() => setStep(AppStep.SUMMARY)} className="flex-1 py-6 text-slate-400 font-bold uppercase text-[10px] tracking-[0.2em] hover:text-slate-600 transition-colors">Review Draft</button>
                      <button onClick={() => { setArchive(prev => [draft, ...prev.filter(a => a.id !== draft.id)]); setStep(AppStep.FINALIZE); }} className="flex-[3] py-7 bg-[#009933] text-white font-black rounded-3xl text-2xl shadow-2xl shadow-green-100 hover:scale-[1.01] transition-all">Generate Clinical Record</button>
                    </div>
                 </div>
              </div>
            )}

            {step === AppStep.FINALIZE && draft && (
              <div className="animate-in zoom-in-95 duration-700 pb-24">
                 <div ref={reportRef} className="max-w-[800px] mx-auto bg-white shadow-2xl p-16 relative border border-slate-100 min-h-[1100px] flex flex-col rounded-sm" id="print-area">
                   
                   <div className="flex justify-between items-start border-b-[6px] border-[#003366] pb-12 mb-12">
                     <div>
                        <h2 className="text-3xl font-black text-[#003366] tracking-tighter leading-none mb-3 italic uppercase">AuraDoc AI</h2>
                        <p className="text-[#009933] text-[10px] font-black uppercase tracking-[0.3em]">Precision Documentation Engine</p>
                        <div className="mt-3 flex items-center gap-3 text-slate-400 text-[9px] font-black uppercase tracking-[0.1em]">
                           <span className="bg-slate-50 px-2 py-0.5 rounded">SESSION: {draft.id.split('-')[0].toUpperCase()}</span>
                        </div>
                     </div>
                     <div className="text-right">
                        <p className="text-2xl font-black text-slate-950 tracking-tighter leading-none">{new Date(draft.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
                        <p className="text-slate-400 text-[11px] font-black uppercase tracking-[0.2em] mt-2">REC: {draft.id.slice(-6).toUpperCase()}</p>
                     </div>
                   </div>

                   <div className="grid grid-cols-3 gap-8 mb-16 bg-[#003366]/5 p-8 rounded-[24px] border border-[#003366]/10">
                      <div className="space-y-1">
                        <p className="text-[9px] font-black uppercase text-slate-400 tracking-[0.1em] mb-1">Patient Name</p>
                        <p className="text-xl font-black text-[#003366] leading-none tracking-tight">{draft.demographics.name}</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[9px] font-black uppercase text-slate-400 tracking-[0.1em] mb-1">Age / Gender</p>
                        <p className="text-xl font-black text-[#003366] leading-none tracking-tight">{draft.demographics.age}y / {draft.demographics.gender}</p>
                      </div>
                      <div className="text-right space-y-1">
                        <p className="text-[9px] font-black uppercase text-slate-400 tracking-[0.1em] mb-1">Capture Time</p>
                        <p className="text-xl font-black text-[#003366] leading-none tracking-tight">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                   </div>
                   
                   <div className="absolute top-[55%] left-[50%] -translate-x-1/2 -translate-y-1/2 opacity-[0.015] pointer-events-none text-[500px] font-black italic select-none">Rx</div>

                   <div className="relative z-10 flex-1 flex flex-col">
                      <div className="flex gap-12 flex-1">
                         <div className="w-[48%] border-r-[2px] border-slate-100 pr-10">
                            <div className="space-y-10">
                               <div>
                                  <p className="text-[10px] font-black uppercase text-slate-300 tracking-[0.3em] mb-8">Clinical Summary</p>
                                  <div className="space-y-8">
                                     <div>
                                        <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1.5">Subjective</p>
                                        <p className="text-sm font-bold text-slate-800 leading-relaxed italic border-l-2 border-[#003366] pl-4">"{draft.soap.subjective}"</p>
                                     </div>
                                     <div>
                                        <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1.5">Objective</p>
                                        <p className="text-sm font-bold text-slate-800 leading-relaxed">{draft.soap.objective}</p>
                                     </div>
                                     <div className="p-5 bg-[#003366] rounded-[16px] shadow-2xl border-l-[6px] border-[#009933]">
                                        <p className="text-[8px] font-black text-white/50 uppercase tracking-widest mb-1.5">Assessment</p>
                                        <p className="text-lg font-black text-white leading-tight tracking-tight">{draft.soap.assessment}</p>
                                     </div>
                                     <div>
                                        <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1.5">Plan</p>
                                        <p className="text-sm font-bold text-slate-800 leading-relaxed">{draft.soap.plan}</p>
                                     </div>
                                  </div>
                               </div>
                            </div>
                         </div>

                         <div className="w-[52%] pl-6">
                            <div className="flex items-center gap-6 mb-12">
                               <h1 className="text-7xl font-black text-[#003366] italic select-none leading-none">Rx</h1>
                               <div className="h-0.5 bg-[#003366] flex-1 rounded-full opacity-[0.08]"></div>
                            </div>

                            <div className="space-y-10">
                               {draft.prescriptions.map((p, i) => (
                                 <div key={i} className="pb-8 border-b-[1px] border-slate-50 last:border-0 relative">
                                   <p className="text-2xl font-black text-slate-950 tracking-tighter leading-none mb-2">{p.medicineName}</p>
                                   <div className="flex items-center gap-4">
                                      <p className="text-[#009933] font-black text-base uppercase tracking-tight">{p.dosage}</p>
                                      <div className="w-1 h-1 rounded-full bg-slate-200" />
                                      <p className="text-slate-400 font-black text-[10px] uppercase tracking-[0.1em]">{p.duration}</p>
                                   </div>
                                   <div className="flex items-center justify-between mt-4">
                                      <p className="text-[9px] font-black text-slate-300 uppercase tracking-widest italic">{p.relationToFood}</p>
                                      <div className="flex gap-1.5">
                                         {['M','A','E','N'].map((t, j) => {
                                           const active = [p.morning, p.afternoon, p.evening, p.night][j];
                                           return <div key={j} className={`w-7 h-7 rounded-lg flex items-center justify-center font-black text-[9px] border-[1px] transition-all ${active ? 'bg-[#003366] text-white border-[#003366] shadow-lg' : 'bg-transparent text-slate-100 border-slate-50'}`}>{t}</div>
                                         })}
                                      </div>
                                   </div>
                                 </div>
                               ))}
                            </div>
                         </div>
                      </div>

                      <div className="mt-auto pt-12 border-t-[2px] border-slate-100 flex justify-between items-end">
                         <div className="max-w-xs space-y-3">
                            <div className="w-10 h-0.5 bg-[#009933] rounded-full" />
                            <p className="text-[7px] text-slate-300 italic font-black uppercase tracking-[0.1em] leading-relaxed">
                               DIGITALLY GENERATED BY AURADOC AI ENGINE • MEDICAL DATA ENCRYPTED • NOT VALID WITHOUT CLINICIAN SIGNATURE.
                            </p>
                         </div>
                         <div className="text-center">
                            <div className="w-56 h-0.5 bg-slate-100 mb-4 rounded-full"/>
                            <p className="text-[9px] font-black text-slate-400 tracking-[0.5em] uppercase">Attending Practitioner</p>
                         </div>
                      </div>
                   </div>
                 </div>

                 <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-16 no-print max-w-[800px] mx-auto">
                   <button onClick={downloadPDF} disabled={isDownloading} className="py-7 bg-[#003366] text-white font-black rounded-[24px] text-xl shadow-2xl hover:scale-[1.03] active:scale-95 transition-all flex items-center justify-center gap-3">
                      {isDownloading ? <div className="w-5 h-5 border-[3px] border-white/20 border-t-white rounded-full animate-spin"></div> : <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>}
                      {isDownloading ? '...' : 'PDF'}
                   </button>
                   <button onClick={handleWhatsAppShare} className="py-7 bg-[#009933] text-white font-black rounded-[24px] text-xl shadow-2xl hover:scale-[1.03] active:scale-95 transition-all flex items-center justify-center gap-3">
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.414 0 .018 5.396 0 12.032c0 2.12.554 4.189 1.604 6.04L0 24l6.104-1.602a11.834 11.834 0 005.942 1.603h.005c6.634 0 12.032-5.396 12.035-12.032a11.762 11.762 0 00-3.472-8.455z"/></svg>
                      WhatsApp
                   </button>
                   <button onClick={copyToClipboard} className="py-7 bg-white border-2 border-slate-200 text-slate-900 font-black rounded-[24px] text-xl transition-all shadow-xl flex items-center justify-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
                      {isCopying ? 'OK' : 'Copy'}
                   </button>
                   <button onClick={resetAllState} className="py-7 bg-white border-2 border-slate-200 text-slate-950 font-black rounded-[24px] text-xl hover:bg-slate-50 transition-all shadow-xl">New File</button>
                 </div>
              </div>
            )}
          </main>
        </>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 20px; border: 2px solid transparent; background-clip: content-box; }
        
        @keyframes progress {
          0% { transform: scaleX(0); }
          50% { transform: scaleX(0.7); }
          100% { transform: scaleX(1); }
        }
        .animate-progress { animation: progress 2s cubic-bezier(.4,0,.2,1) forwards; }
      `}</style>
    </div>
  );
};

export default App;
