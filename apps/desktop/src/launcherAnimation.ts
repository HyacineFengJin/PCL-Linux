/** The cap controls only launcher animations. It cannot control the compositor
 * or video frame rate. CSS remains authoritative for reduced motion and easing.
 * Animation objects are paused and advanced on one shared, bounded cadence. */
export function animateLauncher(fps: number, speedPercent: number): () => void {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const owned = new Map<Animation, { base: number; start: number }>();
  let frame = 0, previous = -Infinity;
  const cadence = 1000 / Math.max(1, Math.min(240, fps));
  const speed = Math.max(.1, Math.min(4, speedPercent / 100));
  function release() {
    for (const animation of owned.keys()) {
      try { if (animation.playState === "paused") animation.play(); } catch { /* A removed effect cannot be resumed. */ }
    }
    owned.clear();
  }
  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    if (motion.matches) { release(); return; }
    if (now - previous + .2 < cadence) return;
    previous = now;
    const current = new Set(document.getAnimations());
    for (const animation of current) {
      if (owned.size >= 512) break;
      if (!owned.has(animation) && animation.playState === "running") {
        const time = animation.currentTime;
        if (typeof time !== "number") continue;
        try {
          animation.pause();
          owned.set(animation, { base: time, start: now });
        } catch { /* Unsupported effects remain on their native timeline. */ }
      }
    }
    for (const [animation, origin] of owned) {
      if (!current.has(animation) || animation.playState === "idle") {
        owned.delete(animation); continue;
      }
      const time = origin.base + (now - origin.start) * speed;
      try {
        const end = animation.effect?.getComputedTiming().endTime;
        if (typeof end === "number" && Number.isFinite(end) && time >= end) {
          animation.finish(); owned.delete(animation);
        } else animation.currentTime = time;
      } catch {
        owned.delete(animation);
        // Losing control of one effect must not strand it paused or prevent
        // other animations from advancing on this frame.
        try { if (animation.playState === "paused") animation.play(); } catch { /* Effect was removed. */ }
      }
    }
  }
  if (typeof document.getAnimations === "function") frame = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(frame); release(); };
}
