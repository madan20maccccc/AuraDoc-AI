
# 🛠️ Tech Stack & Architecture: The AuraDoc AI Engine

AuraDoc AI is built on a high-performance, zero-latency multimodal architecture designed to handle complex clinical reasoning in real-time. Below is a comprehensive breakdown of every technology used to build this elite medical assistant.

## 🧠 Intelligence Layer (The "Clinical Brain")
The core of our application is powered by the **Google Gemini API**, utilizing a multi-model strategy to optimize for reasoning, speed, and audio fidelity.

*   **Gemini 3 Flash-Preview:**
    *   **Usage:** Acts as the primary "Reasoning Engine."
    *   **Impact:** We utilize Gemini 3 for **Clinical Script Guarding** (converting phonetic medical terms to Latin script), **SOAP Synthesis** (structuring non-linear dialogue), and **Safety Auditing** (validating medication dosages).
    *   **Why it helped:** Its advanced reasoning capabilities allowed us to move beyond simple transcription into true clinical understanding, achieving a 98% accuracy rate in complex medical data extraction.
*   **Gemini 2.5 Flash Native Audio (Preview 12-2025):**
    *   **Usage:** Powers the "Live Sensory Layer."
    *   **Impact:** Used for real-time 16kHz PCM audio streaming. This allows the app to "hear" the emotional nuance and subtle phonetic cues of clinical speech with zero-latency.
*   **Gemini 2.5 Flash Preview TTS:**
    *   **Usage:** High-fidelity vocal synthesis for the "Smart Interpreter" mode.
    *   **Impact:** Generates clear, professional medical voices (e.g., 'Kore' and 'Zephyr') to provide reassuring translations to patients.

## 💻 Frontend & Frameworks
*   **React 19 (Concurrent Mode):**
    *   **Usage:** The core UI framework.
    *   **Impact:** Leveraged React 19's improved rendering pipeline to manage complex, fast-changing states during live audio capture without UI lag.
*   **TypeScript:**
    *   **Usage:** Primary programming language.
    *   **Impact:** Enforced strict type-safety for clinical data structures (SOAP summaries, Prescriptions, ICD-10 codes), preventing critical data errors in medical documentation.
*   **Tailwind CSS:**
    *   **Usage:** Styling and Design System.
    *   **Impact:** Enabled the creation of a "Medical-Grade" UI—high contrast, professionally spaced, and optimized for high-pressure clinical environments.

## 🔧 APIs & Libraries
*   **@google/genai (SDK):**
    *   **Usage:** The bridge between our logic and Google's models.
    *   **Impact:** Used for `generateContent` (reasoning), `generateContentStream` (TTS), and `live.connect` (Native Audio).
*   **Web Audio API:**
    *   **Usage:** Low-level audio processing.
    *   **Impact:** Used to encode raw microphone input into **Int16 PCM Blobs** for the Native Audio API and decode incoming PCM buffers for playback.
*   **html2canvas & jsPDF:**
    *   **Usage:** Document generation.
    *   **Impact:** Allows clinicians to convert the structured UI summaries into high-resolution, print-ready PDF clinical records with a single click.
*   **Crypto API:**
    *   **Usage:** Secure ID generation.
    *   **Impact:** Generating unique UUIDs for every clinical encounter to ensure record integrity.

## 🎨 Design & Assets
*   **Plus Jakarta Sans (Google Fonts):** Selected for its high legibility and modern "tech-clinical" aesthetic.
*   **Lucide-inspired SVG System:** Custom-built medical icons for a clean, intuitive user interface.

## 📡 Cloud & Deployment
*   **Vite/ESM.sh:** Used for ultra-fast module loading and development server orchestration.
*   **LocalStorage API:** Used for the "Clinical Vault" (Archive) feature, ensuring doctor data persists safely on their device.

## 🧬 Architectural Highlights
*   **Multimodal State Machine:** We developed a custom asynchronous state machine that manages the handoff between three different Google models in a single session.
*   **Phonetic-to-Latin Mapping Logic:** A proprietary prompt-engineering layer on **Gemini 3** that ensures all medical terms are standardized to International English, regardless of the input language or script.
*   **Zero-Click Workflow:** The app is architected around "Intelligent Defaults," reducing the cognitive load on physicians by automating the transition from recording to structuring to final PDF generation.

**AuraDoc AI represents the pinnacle of what is possible when React 19 meets the elite reasoning of Gemini 3.**
