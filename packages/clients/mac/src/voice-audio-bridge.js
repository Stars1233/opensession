// IPC policy for window.os1.voiceAudio. NativeVoiceAudio owns the helper
// process; this owns *who* may drive it. Exactly one owner exists: the main
// frame of a visible, focused app window that asked to start. The owner is
// established before the microphone permission prompt, so a stop, a
// navigation, a renderer crash or a competing start during the prompt cancels
// the request and no native capture ever begins for it. Audio in both
// directions is bounded by delivery acknowledgements from the preload, so a
// stalled renderer or main process drops packets instead of queueing IPC.
const { validID } = require("./native-dictation");
const { validStartOptions } = require("./native-voice-audio");

// Microphone packets sent to the renderer and not yet acknowledged. The
// helper asks its microphone tap for 20 ms buffers (a hint AVAudioEngine
// may round), so this is roughly 160 ms of slack before frames drop.
const MAX_OUTSTANDING_MIC_PACKETS = 8;

const CHANNELS = {
  devices: "os1:voice-audio-devices",
  start: "os1:voice-audio-start",
  push: "os1:voice-audio-push",
  pushAck: "os1:voice-audio-push-ack",
  pause: "os1:voice-audio-pause",
  clear: "os1:voice-audio-clear",
  stop: "os1:voice-audio-stop",
  audio: "os1:voice-audio-audio",
  audioAck: "os1:voice-audio-audio-ack",
  error: "os1:voice-audio-error",
};

const UNAVAILABLE = "Native voice audio is unavailable.";

class VoiceAudioBridge {
  // `inWindow(url)` says whether a page is one of this shell's app pages,
  // `foreground(webContents)` whether its window is a visible, focused app
  // window, and `micAccessAllowed()` runs the shell's macOS permission flow.
  constructor({
    native,
    inWindow,
    foreground,
    micAccessAllowed,
    maxOutstanding = MAX_OUTSTANDING_MIC_PACKETS,
  }) {
    this.native = native;
    this.inWindow = inWindow;
    this.foreground = foreground;
    this.micAccessAllowed = micAccessAllowed;
    this.maxOutstanding = maxOutstanding;
    this.owner = null;
  }

  register(ipcMain) {
    ipcMain.handle(CHANNELS.devices, (e) => this.devices(e));
    ipcMain.handle(CHANNELS.start, (e, id, options) =>
      this.start(e, id, options),
    );
    ipcMain.on(CHANNELS.push, (e, id, samples) => this.push(e, id, samples));
    ipcMain.on(CHANNELS.audioAck, (e, id) => this.ack(e, id));
    ipcMain.on(CHANNELS.pause, (e, id, paused) =>
      this.setPaused(e, id, paused),
    );
    ipcMain.on(CHANNELS.clear, (e, id) => this.clearPlayback(e, id));
    ipcMain.on(CHANNELS.stop, (e, id) => this.stop(e, id));
  }

  // The main frame of an app page, or null. Every message is checked against
  // its own frame, not the WebContents, so an iframe cannot borrow the page.
  sender(event) {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return null;
    if (!this.inWindow(frame.url)) return null;
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return null;
    return sender;
  }

  // Messages after start must come from the owner's frame with its id.
  ownerFor(event, id) {
    const owner = this.owner;
    if (!owner || owner.cancelled || owner.id !== id) return null;
    return this.sender(event) === owner.sender ? owner : null;
  }

  devices(event) {
    if (!this.sender(event)) return Promise.reject(new Error(UNAVAILABLE));
    return this.native.devices();
  }

  async start(event, id, options) {
    if (!validID(id) || !validStartOptions(options))
      throw new Error("Invalid voice audio request.");
    const sender = this.sender(event);
    if (!sender || !this.foreground(sender)) throw new Error(UNAVAILABLE);
    if (!this.native.available()) throw new Error(UNAVAILABLE);
    if (this.owner) this.release(this.owner, "Replaced by another request.");

    const owner = this.watch(sender, id);
    const current = () =>
      this.owner === owner && !owner.cancelled && !sender.isDestroyed();

    let granted = false;
    try {
      granted = await this.micAccessAllowed();
    } catch {
      granted = false;
    }
    if (!current()) throw new Error("Voice audio request was cancelled.");
    if (!granted) {
      this.release(owner);
      throw new Error("Microphone access is denied.");
    }
    // The page may have changed while the prompt was up. `watch` releases the
    // owner on a main-frame navigation, but check the URL again regardless.
    if (!this.inWindow(sender.getURL())) {
      this.release(owner);
      throw new Error(UNAVAILABLE);
    }

    const deliver = (channel, payload) => {
      if (!current()) return false;
      sender.send(channel, payload);
      return true;
    };
    try {
      await this.native.start(id, options, {
        onAudio: (samples) => {
          if (owner.outstanding >= this.maxOutstanding) {
            owner.dropped += 1;
            return;
          }
          if (deliver(CHANNELS.audio, { id, samples })) owner.outstanding += 1;
        },
        onError: (error) => {
          deliver(CHANNELS.error, { id, error });
          if (this.owner === owner) this.release(owner);
        },
        onClose: () => {
          if (this.owner === owner) this.release(owner);
        },
      });
    } catch (error) {
      if (this.owner === owner) this.release(owner);
      throw error;
    }
    // A stop or navigation during native start already released the owner
    // and asked the helper to stop; report that rather than a live session.
    if (!current()) throw new Error("Voice audio request was cancelled.");
    owner.started = true;
  }

  watch(sender, id) {
    const owner = {
      sender,
      id,
      cancelled: false,
      started: false,
      outstanding: 0,
      dropped: 0,
      detach: null,
    };
    const stop = () => {
      if (this.owner === owner) this.release(owner);
    };
    // Electron passes navigation details both as event properties and as
    // positional arguments; accept either shape.
    const onNavigation = (e, _url, isInPlace, isMainFrame) => {
      const mainFrame = e?.isMainFrame ?? isMainFrame;
      const sameDocument = e?.isSameDocument ?? isInPlace;
      if (mainFrame && !sameDocument) stop();
    };
    sender.on("did-start-navigation", onNavigation);
    sender.on("render-process-gone", stop);
    sender.on("destroyed", stop);
    owner.detach = () => {
      if (sender.isDestroyed()) return;
      sender.removeListener("did-start-navigation", onNavigation);
      sender.removeListener("render-process-gone", stop);
      sender.removeListener("destroyed", stop);
    };
    this.owner = owner;
    return owner;
  }

  // Ends an owner's claim. The helper is asked to stop whether or not it was
  // ever started for this id; NativeVoiceAudio ignores ids it does not know.
  release(owner, message) {
    if (owner.cancelled) return;
    owner.cancelled = true;
    owner.detach?.();
    if (this.owner === owner) this.owner = null;
    if (message && owner.started && !owner.sender.isDestroyed())
      owner.sender.send(CHANNELS.error, { id: owner.id, error: message });
    this.native.stop(owner.id);
  }

  push(event, id, samples) {
    const sender = this.sender(event);
    if (!sender) return;
    // Every accepted push is acknowledged so the preload's outstanding count
    // drains even when the session is over; the counter is the renderer's own.
    sender.send(CHANNELS.pushAck, id);
    const owner = this.ownerFor(event, id);
    if (!owner || !owner.started) return;
    this.native.push(id, samples);
  }

  ack(event, id) {
    const owner = this.ownerFor(event, id);
    if (!owner) return;
    owner.outstanding = Math.max(0, owner.outstanding - 1);
  }

  setPaused(event, id, paused) {
    const owner = this.ownerFor(event, id);
    if (!owner || !owner.started) return;
    this.native.setPaused(id, paused === true);
  }

  clearPlayback(event, id) {
    const owner = this.ownerFor(event, id);
    if (!owner || !owner.started) return;
    this.native.clearPlayback(id);
  }

  stop(event, id) {
    const owner = this.ownerFor(event, id);
    if (owner) this.release(owner);
  }

  stopAll() {
    if (this.owner) this.release(this.owner);
    this.native.stopAll();
  }
}

module.exports = {
  VoiceAudioBridge,
  CHANNELS,
  MAX_OUTSTANDING_MIC_PACKETS,
};
