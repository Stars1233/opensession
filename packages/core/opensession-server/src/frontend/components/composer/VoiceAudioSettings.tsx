import { useState, type ReactNode } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useVoiceAudioDevices } from "../../hooks/useVoiceAudioDevices";
import type { VoiceAudioDevice } from "../../lib/os1-shell";
import { voiceAudioDeviceRows } from "../../lib/voice-audio-menu";
import {
  readVoiceAudioSettings,
  resolveVoiceAudioDevice,
  voiceAudioBridge,
  writeVoiceAudioSettings,
  type VoiceAudioSettings,
} from "../../lib/voice-audio-settings";
import { cn } from "../../ui/cn";
import { Menu } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import { IconChevronDown, IconChevronRight } from "../icons";

/**
 * Audio routing on the Mac desktop shell: which microphone (and, for a
 * call, which output) the next dictation or call uses, and whether other
 * apps' audio is lowered while someone speaks. The choices are one shared
 * preference, reachable from a small chevron attached to the dictation mic
 * and to the handset, so there is no separate settings surface to find.
 *
 * Everything here renders the wrapped control unchanged unless the shell
 * exposes `window.os1.voiceAudio`, so the web, phone and older shells are
 * untouched. Devices come from the native bridge, which lists names without
 * opening the microphone, and are only asked for while the menu is open.
 */

const DUCKING_LABEL = "Lower other audio during speech";
// Off is not a promise of silence from the system: macOS keeps the least
// fade it allows, so the copy says "least", not "none".
const DUCKING_OFF_NOTE = "Off keeps the least fade macOS allows.";
const DUCKING_REQUIREMENT = "Requires macOS 14 or later.";
const SAVE_FAILED = "Couldn't save. Applies in this window only.";
const SHARED_HINT = "Shared by dictation and calls. Applies next time.";

/** The chevron half of the split. It overlaps the primary's box by the 4px
 *  its wash is inset (`paletteIconBtn`'s `before:inset-1`), so the two
 *  washes meet at the hairline and read as one control; the primary's own
 *  wash loses its right corners through the group class below. */
const chevronClasses = cn(
  "relative -ml-1 inline-flex h-10 w-6 shrink-0 items-center justify-center rounded-r-control text-dim transition-[color] hover:text-fg data-[popup-open]:text-fg disabled:cursor-default disabled:opacity-50",
  "before:absolute before:inset-y-1 before:left-0 before:right-0.5 before:z-0 before:rounded-r-control before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-hover data-[popup-open]:before:bg-hover",
  // The seam: short of the top and bottom edges, as the send split's is.
  "after:absolute after:left-0 after:top-1/2 after:h-4 after:w-px after:-translate-y-1/2 after:bg-line after:content-['']",
  "[&>svg]:relative [&>svg]:z-[1]",
  // A narrow window keeps a finger-sized height; the width stays under the
  // primary's so a row of two splits still fits the composer at 390px.
  "phone:min-h-11 phone:w-8",
);

/** Squares the primary's wash where the chevron attaches. Tooltip renders no
 *  wrapper, so the wrapped button is the group's first element child. */
const groupClasses =
  "inline-flex items-center [&>button:first-child]:before:rounded-r-none";

const itemClasses = "phone:min-h-11 data-[disabled]:opacity-50";

function MenuNote({
  tone = "dim",
  children,
}: {
  tone?: "dim" | "warn";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "m-0 px-2 py-1 text-supporting leading-snug",
        tone === "warn" ? "text-yellow" : "text-dim",
      )}
    >
      {children}
    </p>
  );
}

function DeviceRadioGroup({
  kind,
  value,
  devices,
  onChange,
}: {
  kind: "microphone" | "output";
  value: string;
  devices: VoiceAudioDevice[] | null;
  onChange: (id: string) => void;
}) {
  return (
    <Menu.RadioGroup
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      {voiceAudioDeviceRows(value, devices, kind).map((row) => (
        <Menu.RadioItem
          key={row.id}
          value={row.id}
          disabled={row.disabled}
          className={cn(itemClasses, "justify-between gap-3")}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{row.label}</span>
            {row.note && (
              <span className="text-supporting text-dim">{row.note}</span>
            )}
          </span>
          <Menu.Check on={row.id === value} />
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

/** The menu's rows. Mounted only while the menu is open, so each opening
 *  reads the stored choice afresh (a change made from the other split
 *  shows here) and asks the shell for its devices only then. */
function VoiceAudioMenuContent({
  mode,
}: {
  mode: "dictation" | "conversation";
}) {
  const [settings, setSettings] = useState(readVoiceAudioSettings);
  const [saveFailed, setSaveFailed] = useState(false);
  const { state, refresh } = useVoiceAudioDevices();
  // A phone-width window gets the output list as a submenu so the menu
  // stays one screen tall.
  const compact = useIsPhone();
  const list = state.devices;
  // Unknown until the list arrives; only a known "no" disables the row, so
  // it does not flicker off and on while loading.
  const duckingSupported = list ? list.advancedDucking : true;
  const loading = state.status === "loading";
  function update(next: VoiceAudioSettings) {
    setSettings(next);
    setSaveFailed(!writeVoiceAudioSettings(next));
  }
  const output = (
    <DeviceRadioGroup
      kind="output"
      value={settings.outputDeviceId}
      devices={list?.outputs ?? null}
      onChange={(outputDeviceId) => update({ ...settings, outputDeviceId })}
    />
  );
  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel>Microphone</Menu.GroupLabel>
        <DeviceRadioGroup
          kind="microphone"
          value={settings.inputDeviceId}
          devices={list?.inputs ?? null}
          onChange={(inputDeviceId) => update({ ...settings, inputDeviceId })}
        />
      </Menu.Group>
      {mode === "conversation" && (
        <>
          <Menu.Separator />
          {compact ? (
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger
                className={cn(itemClasses, "justify-between gap-3")}
              >
                <span>Output</span>
                <span className="flex min-w-0 items-center gap-1 text-dim">
                  <span className="truncate">
                    {
                      resolveVoiceAudioDevice(
                        settings.outputDeviceId,
                        list?.outputs ?? null,
                        "output",
                      ).label
                    }
                  </span>
                  <IconChevronRight className="shrink-0 text-faint" size={17} />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Popup className="max-w-[min(300px,calc(100vw-1rem))]">
                {output}
              </Menu.Popup>
            </Menu.SubmenuRoot>
          ) : (
            <Menu.Group>
              <Menu.GroupLabel>Output</Menu.GroupLabel>
              {output}
            </Menu.Group>
          )}
        </>
      )}
      <Menu.Separator />
      <Menu.CheckboxItem
        checked={duckingSupported && settings.ducking}
        disabled={!duckingSupported}
        onCheckedChange={(ducking) => update({ ...settings, ducking })}
        className={cn(itemClasses, "justify-between gap-3")}
      >
        {/* Wraps rather than truncates: the row is 280px wide in a
            narrow window and the label is the whole row's meaning. */}
        <span className="min-w-0">{DUCKING_LABEL}</span>
        <Menu.Check on={duckingSupported && settings.ducking} />
      </Menu.CheckboxItem>
      <MenuNote>
        {duckingSupported ? DUCKING_OFF_NOTE : DUCKING_REQUIREMENT}
      </MenuNote>
      <Menu.Separator />
      {state.status === "error" ? (
        <>
          <MenuNote tone="warn">
            Couldn't list audio devices. Your saved choices are kept.
          </MenuNote>
          <Menu.Item
            closeOnClick={false}
            className={itemClasses}
            onClick={refresh}
          >
            Try again
          </Menu.Item>
        </>
      ) : (
        <Menu.Item
          closeOnClick={false}
          disabled={loading}
          className={itemClasses}
          onClick={refresh}
        >
          {loading ? "Checking devices…" : "Refresh devices"}
        </Menu.Item>
      )}
      {saveFailed && <MenuNote tone="warn">{SAVE_FAILED}</MenuNote>}
      <MenuNote>{SHARED_HINT}</MenuNote>
    </>
  );
}

function VoiceAudioSplit({
  mode,
  disabled,
  children,
}: {
  mode: "dictation" | "conversation";
  disabled?: boolean;
  children: ReactNode;
}) {
  const label =
    mode === "dictation" ? "Dictation audio options" : "Call audio options";
  return (
    <Menu.Root modal={false}>
      <span className={groupClasses}>
        {children}
        <Tooltip label={label}>
          <Menu.Trigger
            className={chevronClasses}
            disabled={disabled}
            aria-label={label}
            // The composer toolbar cancels pointerdown at phone width so a
            // tap does not blur the textarea, which also suppresses the
            // mousedown Base UI opens this menu on. Phones never draw the
            // chevron (no native bridge); a narrow Mac window does, with a
            // mouse, so keep its press out of that guard.
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* The icon floor is 20; the glyph's ink is well inside that. */}
            <IconChevronDown size={20} />
          </Menu.Trigger>
        </Tooltip>
      </span>
      <Menu.Popup align="end" className="w-[280px]">
        <VoiceAudioMenuContent mode={mode} />
      </Menu.Popup>
    </Menu.Root>
  );
}

/**
 * Attaches the audio options chevron to a voice control: the dictation mic
 * (`mode="dictation"`) or the handset (`mode="conversation"`, which also
 * offers the output). `children` is the control itself, tooltip included,
 * and stays the primary half: pressing it does what it always did, only the
 * chevron opens the menu. Without the native bridge the children come back
 * untouched, so the web, phone and older shells draw no chevron.
 */
export function VoiceAudioSplitButton({
  mode,
  disabled,
  children,
}: {
  mode: "dictation" | "conversation";
  /** Greys the chevron with the primary; the menu is for the next use. */
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!voiceAudioBridge()) return children;
  return (
    <VoiceAudioSplit mode={mode} disabled={disabled}>
      {children}
    </VoiceAudioSplit>
  );
}
