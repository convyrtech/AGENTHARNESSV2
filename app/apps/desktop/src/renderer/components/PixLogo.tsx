/**
 * PRSLOY monogram — matches apps/desktop/build/icon.svg (paper plate, ink «P», rust dot).
 * The «P» is the Piazzolla outline, so the mark renders the same before fonts load.
 * Keep geometry in sync with icon.svg; regenerate the app icons with scripts/render-icons.cjs.
 */
import { cn } from "../lib/utils.ts";

const P_PATH =
  "M397.96533203125 -652.44921875Q465.830322265625 -652.44921875 514.63916015625 -628.808837890625Q563.447998046875 -605.16845703125 590.14453125 -561.94384765625Q616.841064453125 -518.71923828125 616.841064453125 -459.022705078125Q616.841064453125 -394.27001953125 585.616455078125 -345.573486328125Q554.391845703125 -296.876953125 498.2628173828125 -269.7646484375Q442.1337890625 -242.65234375 366.62841796875 -242.65234375H191.808837890625V-323.34765625H417.640380859375Q450.405029296875 -348.95458984375 465.899658203125 -380.0615234375Q481.394287109375 -411.16845703125 481.394287109375 -450.966552734375Q481.394287109375 -510.70849609375 450.98388671875 -540.9671630859375Q420.573486328125 -571.225830078125 362.752685546875 -571.225830078125H259.504150390625V-68.549560546875L389.18994140625 -48.437255859375V0.0H26.876953125V-43.268798828125Q44.93310546875 -52.85302734375 68.15234375 -59.437255859375Q91.37158203125 -66.021484375 122.75390625 -70.18994140625L133.394287109375 -580.14697265625L26.876953125 -605.011962890625V-652.44921875Z";

export function PixLogo(props: { className?: string; title?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      fill="none"
      className={cn("size-5 shrink-0", props.className)}
      role="img"
      aria-label={props.title ?? "PRSLOY"}
    >
      <title>{props.title ?? "PRSLOY"}</title>
      <rect width="1024" height="1024" rx="229" fill="#f3eee3" />
      <rect
        x="6"
        y="6"
        width="1012"
        height="1012"
        rx="223"
        fill="none"
        stroke="#ddd2c1"
        strokeWidth="12"
      />
      <path transform="translate(171.89 792.5) scale(0.86)" fill="#3b2a1e" d={P_PATH} />
      <circle cx="780" cy="744.5" r="48" fill="#a4472c" />
    </svg>
  );
}
