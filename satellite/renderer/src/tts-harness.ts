// Dev/debug harness: real TtsEngine + real window.speechSynthesis, with
// every lifecycle event logged to the page. Lets us observe whether
// speech actually progresses (boundary events fire only while audio is
// being produced) without needing to hear anything.

import { TtsEngine, type SpokenChunk } from "./tts/TtsEngine";
import { resolveDefaultVoice } from "./tts/defaultVoice";

const logEl = document.getElementById("log") as HTMLPreElement;
function log(msg: string) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  logEl.textContent += line + "\n";
  console.log("[tts-harness]", line);
}

const TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Reck connect satellite text to speech harness test sentence.";

function chunkOf(text: string): SpokenChunk {
  // Minimal rangeMap: one entry per word so boundaries resolve.
  const rangeMap: Array<SpokenChunk["rangeMap"][number]> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let line = 0;
  while ((m = re.exec(text))) {
    rangeMap.push({
      charStart: m.index,
      charEnd: m.index + m[0].length,
      line,
      col: m.index,
      len: m[0].length,
    });
    line += 0;
  }
  return { text, rangeMap };
}

const engine = new TtsEngine();
engine.on("boundary", (b) => log(`boundary word="${b.word}" charIndex=${b.charIndex}`));
engine.on("end", () => log("END"));
engine.on("error", (e) => log(`ERROR: ${e.message}`));

function snapshotSynth(tag: string) {
  const s = window.speechSynthesis;
  log(`${tag}: speaking=${s.speaking} pending=${s.pending} paused=${s.paused}`);
}

async function speak(withVoice: boolean) {
  const voices = window.speechSynthesis.getVoices();
  log(`voices available: ${voices.length}`);
  const voice = withVoice ? (resolveDefaultVoice(voices, "en") ?? null) : null;
  log(`using voice: ${voice ? `${voice.name} (${voice.lang})` : "NONE"}`);
  engine.start(chunkOf(TEXT), voice ? { voice } : {});
  snapshotSynth("t+0ms");
  for (const ms of [250, 1000, 3000]) {
    setTimeout(() => snapshotSynth(`t+${ms}ms`), ms);
  }
}

document.getElementById("speak")!.addEventListener("click", () => void speak(true));
document
  .getElementById("speak-voiceless")!
  .addEventListener("click", () => void speak(false));
document.getElementById("stop")!.addEventListener("click", () => {
  engine.stop();
  log("stop() called");
});

log(`speechSynthesis present: ${typeof window.speechSynthesis !== "undefined"}`);
window.speechSynthesis.addEventListener?.("voiceschanged", () =>
  log(`voiceschanged: ${window.speechSynthesis.getVoices().length} voices`),
);
