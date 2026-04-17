import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Randomized thinking phrases — Claude-flavored personality
// ---------------------------------------------------------------------------
const THINKING_PHRASES = [
  "Thinking...",
  "Pondering...",
  "Mulling it over...",
  "Reasoning...",
  "Considering...",
  "Working through it...",
  "Turning it over...",
  "Piecing it together...",
  "Connecting the dots...",
  "Noodling on it...",
  "Deliberating...",
  "Processing...",
  "Weighing options...",
  "Reflecting...",
  "Chewing on that...",
  "Let me think...",
  "Hmm, let me see...",
  "Figuring it out...",
  "Spinning up thoughts...",
  "On it...",
];

/** Pick a random thinking phrase. Stable per mount — only changes on remount. */
export function useThinkingPhrase(): string {
  const [phrase] = useState(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
  );
  return phrase;
}

/**
 * Pick a new random thinking phrase every `intervalMs`, ensuring the new one
 * differs from the current one.
 */
export function useRotatingThinkingPhrase(intervalMs = 4000): string {
  const [phrase, setPhrase] = useState(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
  );
  const phraseRef = useRef(phrase);
  phraseRef.current = phrase;

  useEffect(() => {
    const id = setInterval(() => {
      let next: string;
      do {
        next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
      } while (next === phraseRef.current && THINKING_PHRASES.length > 1);
      setPhrase(next);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return phrase;
}

// ---------------------------------------------------------------------------
// Animated robot icon (for "thinking" state)
// ---------------------------------------------------------------------------
interface IconProps {
  size?: number;
  className?: string;
}

export function AnimatedRobotIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-robot-bob ${className}`}
    >
      {/* Antenna bulb — glows */}
      <circle
        cx="12" cy="3" r="1.5"
        className="fill-accent animate-robot-antenna"
      />
      {/* Antenna stick */}
      <line x1="12" y1="4.5" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Head */}
      <rect x="5" y="8" width="14" height="10" rx="3" stroke="currentColor" strokeWidth="1.5" />
      {/* Eyes */}
      <circle cx="9.5" cy="13" r="1.5" className="fill-accent" />
      <circle cx="14.5" cy="13" r="1.5" className="fill-accent" />
      {/* Mouth */}
      <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      {/* Ears */}
      <line x1="3" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="19" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Body stub */}
      <line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="9" y1="21" x2="15" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Animated tool / wrench icon (for "tool_use" state)
// ---------------------------------------------------------------------------
export function AnimatedToolIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-tool-spin ${className}`}
      style={{ transformOrigin: "center center" }}
    >
      {/* Wrench shape */}
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
