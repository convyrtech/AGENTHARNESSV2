/**
 * First-run step «search» between the key and the folder: search. Owned by features, #23.
 * Placeholder until then: passes at once.
 */
import { useEffect } from "react";
import type { FirstRunStepProps } from "@/lib/prsloy-first-run";

export function FirstRunSearch({ onDone }: FirstRunStepProps) {
  useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}
