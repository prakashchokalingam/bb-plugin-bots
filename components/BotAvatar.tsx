import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { tintFor, type BlobAvatar } from "@/bots";

const SIZES = { sm: "size-8 text-base", md: "size-10 text-xl", lg: "size-12 text-2xl" } as const;
const PATHS = {
  round: "M50 8 C76 7 92 25 92 50 C92 76 76 91 50 92 C24 93 8 75 8 50 C8 25 24 9 50 8Z",
  flower: "M50 9 C61 -1 70 11 70 20 C82 15 91 24 86 36 C100 42 99 55 87 61 C92 74 82 83 70 79 C66 94 54 98 46 87 C35 98 23 91 25 79 C11 83 4 72 12 61 C0 53 3 41 15 36 C10 23 20 15 31 20 C33 8 42 3 50 9Z",
  star: "M50 5 Q56 5 60 19 L64 30 L77 22 Q88 16 85 30 L81 42 L94 48 Q102 53 90 60 L79 65 L82 80 Q83 91 72 85 L61 78 L54 92 Q49 101 43 91 L37 78 L23 85 Q13 89 17 77 L21 65 L8 59 Q-1 53 10 47 L21 42 L16 28 Q13 17 25 23 L37 30 L42 16 Q45 5 50 5Z",
  cloud: "M21 76 C3 75 2 50 19 44 C15 25 34 16 46 26 C56 9 80 16 81 34 C99 37 101 60 87 70 C84 81 70 83 62 79 C49 86 37 83 31 78 Z",
  heart: "M50 87 C44 83 9 62 9 38 C9 13 36 8 50 28 C64 8 91 13 91 38 C91 62 56 83 50 87Z",
  shield: "M50 8 Q68 17 85 18 Q89 19 89 26 L88 51 Q87 73 53 91 Q50 93 47 91 Q13 73 12 51 L11 26 Q11 19 15 18 Q32 17 50 8Z",
  hexagon: "M34 10 Q38 8 42 8 L58 8 Q62 8 66 10 L85 22 Q90 25 90 31 L90 69 Q90 75 85 78 L66 90 Q62 92 58 92 L42 92 Q38 92 34 90 L15 78 Q10 75 10 69 L10 31 Q10 25 15 22Z",
  sun: "M50 5 Q55 5 58 16 Q62 23 69 16 Q77 10 80 16 Q84 20 80 29 Q79 35 88 36 Q99 38 95 46 Q94 50 87 54 Q82 59 89 66 Q95 74 88 78 Q84 81 76 78 Q69 77 66 86 Q62 97 55 92 Q50 88 46 93 Q38 97 35 86 Q32 78 25 80 Q15 83 13 76 Q11 71 17 64 Q22 58 13 54 Q4 49 7 42 Q9 37 18 36 Q26 35 22 27 Q18 17 25 15 Q30 13 37 20 Q43 24 45 14 Q46 5 50 5Z",
  triangle: "M43 13 Q50 2 57 13 L91 76 Q97 88 83 89 L17 89 Q3 88 9 76Z",
} as const;
export function BotAvatar({ botId, emoji, avatar, size = "md", className, animated = false, animateOnHover = false }: { botId: string; emoji: string; avatar?: BlobAvatar | null; size?: keyof typeof SIZES; className?: string; animated?: boolean; animateOnHover?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!animated || !element) return;
    let intersects = typeof IntersectionObserver === "undefined";
    const update = () => setVisible(intersects && document.visibilityState !== "hidden");
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => { intersects = !!entries[0]?.isIntersecting; update(); });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [animated, !!avatar]);
  if (avatar && PATHS[avatar.shape] && /^#[0-9a-fA-F]{6}$/.test(avatar.color)) {
    const rgb = [1, 3, 5].map(i => parseInt(avatar.color.slice(i, i + 2), 16));
    const luminance = rgb.reduce((sum, v, i) => { const c = v / 255; return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!; }, 0);
    const eyes = luminance > .18 ? "#17131f" : "#ffffff";
    return <span ref={ref} aria-hidden className={cn("flex shrink-0 items-center justify-center", SIZES[size], className)}>
      {(animated || animateOnHover) && <style>{`@keyframes bot-avatar-breathe { 0%,100% { transform: scale(1) } 50% { transform: scale(1.035, .97) } } @keyframes bot-avatar-blink { 0%, 44%, 47%, 100% { transform: scaleY(1) } 45.5% { transform: scaleY(.08) } } @media (prefers-reduced-motion: no-preference) { .bot-avatar-motion { animation: bot-avatar-breathe 4s ease-in-out infinite; transform-origin: center; } .bot-avatar-eyes { animation: bot-avatar-blink 6s ease-in-out infinite; transform-origin: 50px 50px; } .bot-avatar-paused, .bot-avatar-paused .bot-avatar-eyes { animation-play-state: paused; } .bot-rail-trigger:hover .bot-avatar-hover, .bot-rail-trigger:focus-visible .bot-avatar-hover { animation: bot-avatar-breathe 4s ease-in-out infinite; transform-origin: center; } .bot-rail-trigger:hover .bot-avatar-hover-eyes, .bot-rail-trigger:focus-visible .bot-avatar-hover-eyes { animation: bot-avatar-blink 6s ease-in-out infinite; transform-origin: 50px 50px; } }`}</style>}
      <svg className={animated ? cn("bot-avatar-motion", !visible && "bot-avatar-paused") : animateOnHover ? "bot-avatar-hover" : undefined} viewBox="0 0 100 100" width="100%" height="100%"><path d={PATHS[avatar.shape]} fill={avatar.color} stroke="currentColor" strokeOpacity=".16" strokeWidth="2"/><g className={animated ? "bot-avatar-eyes" : animateOnHover ? "bot-avatar-hover-eyes" : undefined}><ellipse cx="40" cy="50" rx="4" ry="6" fill={eyes}/><ellipse cx="60" cy="50" rx="4" ry="6" fill={eyes}/></g></svg></span>;
  }
  return <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-lg", SIZES[size], tintFor(botId), className)}>{emoji}</span>;
}
