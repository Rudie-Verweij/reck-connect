// IPC router for cloud (Deepgram) dictation. The renderer captures the mic
// and streams linear16 frames here; this process holds the encrypted API
// key, opens the Deepgram websocket, and forwards interim/final transcripts
// back to the renderer over the "transcription:event" channel.
//
// The embedded (local Whisper) engine runs entirely in the renderer worker
// and does not touch this router.

import { ipcMain, type BrowserWindow } from "electron";
import { readConfig } from "../storage";
import { DeepgramSession } from "./deepgram";

export interface TranscriptionEvent {
  sessionId: number;
  kind: "partial" | "final" | "error" | "closed" | "debug";
  text: string;
}

export interface DeepgramStartResult {
  ok: boolean;
  sessionId?: number;
  error?: string;
}

export function registerTranscriptionIpc(getWindow: () => BrowserWindow | null): void {
  const sessions = new Map<number, DeepgramSession>();
  let nextId = 1;

  const send = (payload: TranscriptionEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("transcription:event", payload);
  };

  ipcMain.handle(
    "transcription:deepgram:start",
    async (_e, sampleRate: unknown, language: unknown): Promise<DeepgramStartResult> => {
      const rate =
        typeof sampleRate === "number" && sampleRate > 0 ? Math.round(sampleRate) : 16000;
      const lang =
        typeof language === "string" && language !== "auto" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)
          ? language
          : undefined;
      const key = readConfig("transcription.deepgramKey");
      if (typeof key !== "string" || key.length === 0) {
        return {
          ok: false,
          error: "No Deepgram API key configured. Add one in Settings → Voice dictation.",
        };
      }
      const id = nextId++;
      const dg = new DeepgramSession();
      try {
        await dg.open(key, rate, lang, {
          onPartial: (text) => send({ sessionId: id, kind: "partial", text }),
          onFinal: (text) => send({ sessionId: id, kind: "final", text }),
          onError: (message) => send({ sessionId: id, kind: "error", text: message }),
          onClosed: () => send({ sessionId: id, kind: "closed", text: "" }),
          onDebug: (message) => send({ sessionId: id, kind: "debug", text: message }),
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      sessions.set(id, dg);
      return { ok: true, sessionId: id };
    },
  );

  // High-rate audio frames: fire-and-forget one-way channel.
  ipcMain.on("transcription:deepgram:frame", (_e, sessionId: unknown, bytes: unknown) => {
    if (typeof sessionId !== "number") return;
    const dg = sessions.get(sessionId);
    if (!dg) return;
    if (bytes instanceof Uint8Array) {
      dg.sendAudio(bytes);
    } else if (ArrayBuffer.isView(bytes)) {
      const view = bytes as ArrayBufferView;
      dg.sendAudio(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
  });

  ipcMain.handle("transcription:deepgram:stop", (_e, sessionId: unknown): boolean => {
    if (typeof sessionId !== "number") return false;
    const dg = sessions.get(sessionId);
    if (!dg) return false;
    dg.close();
    sessions.delete(sessionId);
    return true;
  });
}
