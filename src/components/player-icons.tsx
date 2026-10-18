import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** Shared base so every control icon shares a consistent stroke width. */
function base(size: number, props: IconProps) {
  const { size: _size, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...rest,
  };
}

export function PlayIcon({ size = 22, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M7.6 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.13 4.35A1 1 0 0 0 7.6 5.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PauseIcon({ size = 22, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="6.6" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none" />
      <rect x="13.8" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function VolumeHighIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2.4l3.7 3.2a1 1 0 0 0 1.4-.76V6.06a1 1 0 0 0-1.4-.76L7.4 8.5H5a1 1 0 0 0-1 1Z" fill="currentColor" stroke="none" />
      <path d="M15.4 9.2a4.1 4.1 0 0 1 0 5.6" />
      <path d="M17.7 6.9a7.2 7.2 0 0 1 0 10.2" />
    </svg>
  );
}

export function VolumeMuteIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2.4l3.7 3.2a1 1 0 0 0 1.4-.76V6.06a1 1 0 0 0-1.4-.76L7.4 8.5H5a1 1 0 0 0-1 1Z" fill="currentColor" stroke="none" />
      <path d="M15.6 9.4 20 13.8M19.9 9.4 15.5 13.8" />
    </svg>
  );
}

export function SubtitlesIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3" y="5" width="18" height="14" rx="2.6" />
      <path d="M6.6 15.4c.5-1.2 1.5-1.9 2.8-1.9M14.6 15.4c.5-1.2 1.5-1.9 2.8-1.9" />
      <path d="M6.6 11.7c.5-1.2 1.5-1.9 2.8-1.9M14.6 11.7c.5-1.2 1.5-1.9 2.8-1.9" />
    </svg>
  );
}

export function QualityIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3" y="5" width="18" height="14" rx="2.6" />
      <path d="M7 15V9.4h1.7a1.6 1.6 0 0 1 1.6 1.6v2a1.6 1.6 0 0 1-1.6 1.6H7ZM13.6 12.4h3M15.1 10V15M15.1 12.4 17 10" />
    </svg>
  );
}

export function SpeedIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M5 15.2a7.4 7.4 0 1 1 13.4 0" />
      <path d="M12 15.2 15.3 9.6" />
      <circle cx="12" cy="15.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TheaterIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3.4" y="8" width="17.2" height="8.6" rx="1.8" />
    </svg>
  );
}

export function ExitTheaterIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3.4" y="9" width="17.2" height="7" rx="1.8" />
      <path d="M8 6.2h8M12 3.8v2.4" />
    </svg>
  );
}

export function PipIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <rect x="3" y="5" width="18" height="14" rx="2.2" />
      <rect x="12.4" y="12.4" width="6.6" height="4.6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FullscreenIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4 9V6a2 2 0 0 1 2-2h3" />
      <path d="M20 9V6a2 2 0 0 0-2-2h-3" />
      <path d="M4 15v3a2 2 0 0 0 2 2h3" />
      <path d="M20 15v3a2 2 0 0 1-2 2h-3" />
    </svg>
  );
}

export function ExitFullscreenIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M9 4v3a2 2 0 0 1-2 2H4" />
      <path d="M15 4v3a2 2 0 0 0 2 2h3" />
      <path d="M9 20v-3a2 2 0 0 0-2-2H4" />
      <path d="M15 20v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

export function RetryIcon({ size = 18, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M4.6 12a7.4 7.4 0 0 1 12.7-5.2l1.5 1.5" />
      <path d="M19.2 5.3v4h-4" />
      <path d="M19.4 12a7.4 7.4 0 0 1-12.7 5.2l-1.5-1.5" />
      <path d="M4.8 18.7v-4h4" />
    </svg>
  );
}

export function AlertIcon({ size = 26, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M12 4.4 21 19a1 1 0 0 1-.86 1.5H3.86A1 1 0 0 1 3 19L12 4.4Z" />
      <path d="M12 9.6v4.3" />
      <circle cx="12" cy="16.9" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClockIcon({ size = 16, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.6V12l2.9 1.9" />
    </svg>
  );
}

export function NextIcon({ size = 16, ...p }: IconProps) {
  return (
    <svg {...base(size, p)}>
      <path d="M8.2 6.6v10.8a.7.7 0 0 0 1.08.58l8.2-5.4a.7.7 0 0 0 0-1.16l-8.2-5.4a.7.7 0 0 0-1.08.58Z" fill="currentColor" stroke="none" />
      <path d="M17.6 6v12" />
    </svg>
  );
}

export function CheckIcon({ size = 14, ...p }: IconProps) {
  return (
    <svg {...base(size, p)} strokeWidth={2.4}>
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

export function XIcon({ size = 14, ...p }: IconProps) {
  return (
    <svg {...base(size, p)} strokeWidth={2.2}>
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}