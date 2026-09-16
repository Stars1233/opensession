/** Adapted from Boring Avatars' marble variant (MIT).
 * Copyright (c) 2021 boringdesigners. See boring-avatar.LICENSE.
 * https://github.com/boringdesigners/boring-avatars
 * Uses session seeds, theme colors, and a clip path instead of a white mask.
 */
import { useId } from "react";
import { agentIdentity, agentMarble } from "../lib/agent-identity";
import { cn } from "./cn";

export function AgentAvatar({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const id = useId();
  const properties = agentMarble(agentIdentity(sessionId).seed);
  const [base, middle, top] = properties;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 80 80"
      fill="none"
      className={cn("inline-block size-6 shrink-0 rounded-full", className)}
    >
      <defs>
        <clipPath id={`${id}-clip`}>
          <circle cx="40" cy="40" r="40" />
        </clipPath>
        <filter
          id={`${id}-blur`}
          x="-100%"
          y="-100%"
          width="300%"
          height="300%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="80" height="80" fill={base!.color} />
        <path
          filter={`url(#${id}-blur)`}
          d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z"
          fill={middle!.color}
          transform={`translate(${middle!.x} ${middle!.y}) rotate(${middle!.rotate} 40 40) scale(${top!.scale})`}
        />
        <path
          filter={`url(#${id}-blur)`}
          style={{ mixBlendMode: "overlay" }}
          d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z"
          fill={top!.color}
          transform={`translate(${top!.x} ${top!.y}) rotate(${top!.rotate} 40 40) scale(${top!.scale})`}
        />
      </g>
    </svg>
  );
}
