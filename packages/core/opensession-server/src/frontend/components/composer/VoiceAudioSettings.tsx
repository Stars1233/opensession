import { useId, useState } from "react";
import { motion } from "motion/react";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  useVoiceAudioDevices,
  type VoiceAudioDevicesState,
} from "../../hooks/useVoiceAudioDevices";
import type { VoiceAudioDevice } from "../../lib/os1-shell";
import {
  readVoiceAudioSettings,
  resolveVoiceAudioDevice,
  voiceAudioBridge,
  writeVoiceAudioSettings,
  type VoiceAudioSettings,
} from "../../lib/voice-audio-settings";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Modal } from "../../ui/modal";
import { composerMorph } from "../../ui/motion";
import { OptionSelect } from "../../ui/select";
import { SwitchRow } from "../../ui/setting-row";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { InlineAlert } from "../../ui/state";
import { Tooltip } from "../../ui/tooltip";
import { IconSliders, IconX } from "../icons";

/**
 * Audio routing for voice calls on the Mac desktop shell: which microphone
 * and output the next call uses, and whether other apps' audio is lowered
 * while someone speaks. Every surface here renders nothing unless the shell
 * exposes `window.os1.voiceAudio`, so the web, phone and older shells are
 * untouched.
 *
 * Devices come from the native bridge, which lists names without opening the
 * microphone; there is no `enumerateDevices` call and no permission prompt
 * from opening this dialog.
 */

const DIALOG_TITLE = "Voice audio";
const DIALOG_DESCRIPTION =
  "Microphone and output for voice calls in this app. Changes apply to the next call.";

// Base UI's Select shows its placeholder for an empty-string value, so the
// system default is a named option in the list and mapped back to "" when
// stored.
const SYSTEM_DEFAULT_OPTION = "__system_default__";

const GUIDANCE =
  "Using a Bluetooth headset's microphone switches it to a lower quality call mode. To keep music quality on Bluetooth headphones, choose the built-in or an external microphone here and keep the headphones as the output.";

const DUCKING_LABEL = "Lower other audio during speech";
// Off is not a promise of silence from the system: macOS keeps the least
// fade it allows for a call, so the copy says "least", not "none".
const DUCKING_DESCRIPTION =
  "On, macOS fades other apps' audio while someone speaks and brings it back afterwards. Off keeps the fade to the least macOS allows for a call.";
const SAVE_FAILED =
  "Couldn't save these settings. They apply to calls in this window until the app restarts.";
const DUCKING_REQUIREMENT = "Requires macOS 14 or later.";

function DeviceField({
  kind,
  label,
  value,
  devices,
  onChange,
}: {
  kind: "microphone" | "output";
  label: string;
  value: string;
  devices: VoiceAudioDevice[] | null;
  onChange: (id: string) => void;
}) {
  const selection = resolveVoiceAudioDevice(value, devices, kind);
  const options = [
    { value: SYSTEM_DEFAULT_OPTION, label: "System default" },
    ...(devices ?? []).map((device) => ({
      value: device.id,
      label: device.label,
    })),
  ];
  // A saved device the machine does not list right now stays selected and
  // says so. Dropping it to the system default would, after pairing a
  // headset, quietly pick that headset's low quality microphone.
  if (value !== "" && !devices?.some((device) => device.id === value)) {
    options.push({
      value,
      label:
        selection.connected === false
          ? `${selection.label} (not connected)`
          : selection.label,
    });
  }
  const noteId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label font-medium text-dim">{label}</span>
      <OptionSelect
        label={label}
        className="w-full"
        value={value === "" ? SYSTEM_DEFAULT_OPTION : value}
        options={options}
        onChange={(next) =>
          onChange(next === SYSTEM_DEFAULT_OPTION ? "" : next)
        }
      />
      {selection.connected === false && (
        <p id={noteId} role="status" className="m-0 text-supporting text-dim">
          Not connected right now. Reconnect it or choose another {kind}.
        </p>
      )}
    </div>
  );
}

/** The dialog's body, with the device lists and the person's choices handed
 *  in, so the same form can be drawn from a test without the native bridge. */
export function VoiceAudioSettingsForm({
  settings,
  devices,
  callActive,
  saveFailed,
  onChange,
  onRefresh,
}: {
  settings: VoiceAudioSettings;
  devices: VoiceAudioDevicesState;
  /** A call is up right now, so the choices only reach the next one. */
  callActive?: boolean;
  /** Storage refused the last write: the choice holds for this window only. */
  saveFailed?: boolean;
  onChange: (next: VoiceAudioSettings) => void;
  onRefresh: () => void;
}) {
  const list = devices.devices;
  // Unknown until the list arrives; only a known "no" disables the switch,
  // so the control does not flicker off and on while loading.
  const duckingSupported = list ? list.advancedDucking : true;
  const loading = devices.status === "loading";
  return (
    <div className="flex flex-col gap-4">
      {callActive && (
        <p
          role="status"
          className="m-0 rounded-lg bg-panel px-3 py-2 text-supporting leading-snug text-dim"
        >
          A call is in progress. These changes apply to your next call.
        </p>
      )}
      <DeviceField
        kind="microphone"
        label="Microphone"
        value={settings.inputDeviceId}
        devices={list?.inputs ?? null}
        onChange={(inputDeviceId) => onChange({ ...settings, inputDeviceId })}
      />
      <DeviceField
        kind="output"
        label="Output"
        value={settings.outputDeviceId}
        devices={list?.outputs ?? null}
        onChange={(outputDeviceId) => onChange({ ...settings, outputDeviceId })}
      />
      <p className="m-0 text-supporting leading-snug text-dim">{GUIDANCE}</p>
      {saveFailed && <InlineAlert variant="warn">{SAVE_FAILED}</InlineAlert>}
      {devices.status === "error" ? (
        <InlineAlert
          title="Couldn't list audio devices."
          onRetry={onRefresh}
          retryLabel="Try again"
        >
          {devices.error !== "Couldn't list audio devices."
            ? devices.error
            : "Your saved choices are kept. Try again after reconnecting the device."}
        </InlineAlert>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span
            role="status"
            aria-live="polite"
            className="text-supporting text-faint"
          >
            {loading
              ? "Checking devices…"
              : "Plugged something in? Refresh the list."}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 phone:min-h-11"
            disabled={loading}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </div>
      )}
      {/* Outdented by the row's own padding so its label sits on the
          fields' x, as the settings popovers do. */}
      <div className="-mx-2 flex flex-col">
        <SwitchRow
          label={DUCKING_LABEL}
          checked={duckingSupported && settings.ducking}
          disabled={!duckingSupported}
          onCheckedChange={(ducking) => onChange({ ...settings, ducking })}
        />
        <p className="m-0 px-2 text-supporting leading-snug text-dim">
          {duckingSupported ? DUCKING_DESCRIPTION : DUCKING_REQUIREMENT}
        </p>
      </div>
    </div>
  );
}

function VoiceAudioSettingsContent({ callActive }: { callActive?: boolean }) {
  // Read once per opening: the dialog unmounts when closed, so the next
  // opening starts from whatever is stored by then.
  const [settings, setSettings] = useState(readVoiceAudioSettings);
  const [saveFailed, setSaveFailed] = useState(false);
  const { state, refresh } = useVoiceAudioDevices();
  return (
    <VoiceAudioSettingsForm
      settings={settings}
      devices={state}
      callActive={callActive}
      saveFailed={saveFailed}
      onChange={(next) => {
        setSettings(next);
        setSaveFailed(!writeVoiceAudioSettings(next));
      }}
      onRefresh={refresh}
    />
  );
}

export function VoiceAudioSettingsDialog({
  open,
  onOpenChange,
  callActive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callActive?: boolean;
}) {
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <ResponsiveDialog
        open={open}
        onClose={() => onOpenChange(false)}
        phone
        label={DIALOG_TITLE}
        sheetClassName="max-h-[88dvh]"
      >
        <div className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-0.5">
          <h2 className="m-0 min-w-0 flex-1 text-dialog-title font-semibold leading-tight tracking-[-0.01em] text-fg">
            {DIALOG_TITLE}
          </h2>
          <SheetIconButton
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <IconX />
          </SheetIconButton>
        </div>
        <p className="m-0 px-6 pb-4 text-supporting leading-snug text-dim">
          {DIALOG_DESCRIPTION}
        </p>
        <SheetBody className="px-6 pb-6">
          <VoiceAudioSettingsContent callActive={callActive} />
        </SheetBody>
      </ResponsiveDialog>
    );
  }
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[28rem]" className="gap-3">
        <Modal.Header title={DIALOG_TITLE} description={DIALOG_DESCRIPTION} />
        <VoiceAudioSettingsContent callActive={callActive} />
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The way in: an icon beside the composer's handset (`placement="composer"`)
 * or a labelled button in the live call's status row (`placement="status"`).
 * Both open the same dialog. Renders nothing without the native bridge.
 */
export function VoiceAudioSettingsAction({
  placement,
  className,
  minimized = false,
  callActive,
  disabled,
}: {
  placement: "composer" | "status";
  /** The composer's icon-button classes, so the control sits in the row
   *  like the handset beside it. */
  className?: string;
  /** The composer's resting pill, where the control takes its ordering. */
  minimized?: boolean;
  callActive?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!voiceAudioBridge()) return null;
  const dialog = (
    <VoiceAudioSettingsDialog
      open={open}
      onOpenChange={setOpen}
      callActive={callActive}
    />
  );
  if (placement === "status") {
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconSliders size={18} />}
          className="shrink-0 phone:min-h-11"
          aria-label="Voice audio settings"
          onClick={() => setOpen(true)}
        >
          Audio
        </Button>
        {dialog}
      </>
    );
  }
  return (
    <motion.div
      layout="position"
      transition={composerMorph}
      layoutDependency={minimized}
      className={cn(
        "inline-flex shrink-0 items-center",
        // Sits with the handset in the resting pill.
        minimized && "order-3",
      )}
    >
      <Tooltip label="Voice audio settings">
        <Button
          variant="ghost"
          size="sm"
          className={className}
          disabled={disabled}
          aria-label="Voice audio settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <IconSliders size={22} />
        </Button>
      </Tooltip>
      {dialog}
    </motion.div>
  );
}
