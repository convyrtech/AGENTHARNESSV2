// @ts-expect-error -- plain CommonJS fixture without types
import dep from "./dep.cjs";

console.log((dep as { probe: string }).probe);
